import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger';
import { config } from '../config/config';

// Extend Request interface to include logger
declare global {
  namespace Express {
    interface Request {
      logger?: any;
    }
  }
}

// In-memory store for user rate limiting (in production, use Redis)
const userRateLimitStore = new Map<string, { count: number; resetTime: number }>();

// HTTPS enforcement middleware
export const httpsEnforcement = (req: Request, res: Response, next: NextFunction) => {
  // Skip HTTPS enforcement in development
  if (config.env === 'development') {
    return next();
  }

  // Check if request is secure (HTTPS)
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  
  if (!isSecure) {
    // Redirect to HTTPS
    const httpsUrl = `https://${req.get('host')}${req.originalUrl}`;
    logger.warn('HTTPS redirect triggered', {
      originalUrl: req.originalUrl,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });
    
    return res.redirect(301, httpsUrl);
  }

  // Set security headers for HTTPS
  res.set({
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });

  next();
};

// Per-user rate limiting middleware (DISABLED)
export const createUserRateLimit = (options: {
  windowMs: number;
  max: number;
  message?: string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}) => {
  return (req: Request, res: Response, next: NextFunction) => {
    // Rate limiting disabled - pass through all requests
    next();
  };
};

// Enhanced security headers middleware
export const securityHeaders = (req: Request, res: Response, next: NextFunction) => {
  // Additional security headers
  res.set({
    'X-DNS-Prefetch-Control': 'off',
    'X-Download-Options': 'noopen',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin'
  });

  // Remove server information
  res.removeHeader('X-Powered-By');

  next();
};

// Request ID middleware for better tracking
export const requestId = (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.headers['x-request-id'] as string || 
                   `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  req.headers['x-request-id'] = requestId;
  res.set('X-Request-ID', requestId);
  
  // Add request ID to logger context
  req.logger = logger.child({ requestId });
  
  next();
};

// Security monitoring middleware
export const securityMonitoring = (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  
  // Log suspicious patterns
  const suspiciousPatterns = [
    /\.\./,  // Path traversal
    /<script/i,  // XSS attempts
    /union.*select/i,  // SQL injection
    /javascript:/i,  // JavaScript injection
    /eval\(/i,  // Code injection
  ];

  const url = req.originalUrl;
  const body = JSON.stringify(req.body || {});
  const query = JSON.stringify(req.query || {});
  
  const suspiciousContent = [url, body, query].join(' ');
  
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(suspiciousContent)) {
      logger.warn('Suspicious request detected', {
        pattern: pattern.toString(),
        url: req.originalUrl,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        userId: req.user?.id,
        body: req.body,
        query: req.query
      });
      break;
    }
  }

  // Monitor response time for potential DoS
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    
    if (duration > 5000) { // 5 seconds
      logger.warn('Slow request detected', {
        url: req.originalUrl,
        method: req.method,
        duration,
        ip: req.ip,
        userId: req.user?.id,
        statusCode: res.statusCode
      });
    }
  });

  next();
};

// API versioning middleware
export const apiVersioning = (req: Request, res: Response, next: NextFunction): void => {
  const apiVersion = req.headers['api-version'] || 'v1';
  const supportedVersions = ['v1'];
  
  if (!supportedVersions.includes(apiVersion as string)) {
    res.status(400).json({
      error: 'Unsupported API Version',
      message: `API version ${apiVersion} is not supported. Supported versions: ${supportedVersions.join(', ')}`,
      supportedVersions
    });
    return;
  }
  
  res.set('API-Version', apiVersion);
  next();
};
