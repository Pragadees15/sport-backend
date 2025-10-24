import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { createServer } from 'http';
import { Server } from 'socket.io';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { config } from './config/config';
import { logger } from './utils/logger';

// Import routes
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import postRoutes from './routes/posts';
import commentRoutes from './routes/comments';
import messageRoutes from './routes/messages';
import conversationRoutes from './routes/conversations';
import messagingRoutes from './routes/messaging';
import notificationRoutes from './routes/notifications';
import tokenRoutes from './routes/tokens';
import uploadRoutes from './routes/upload';
import adminRoutes from './routes/admin';
import videoRoutes from './routes/videos';
import membershipRoutes from './routes/memberships';
import livestreamRoutes from './routes/livestreams';
import eventRoutes from './routes/events';
import locationRoutes from './routes/locations';
import discoverRoutes from './routes/discover';
import migrationRoutes from './routes/migration';
import verificationRoutes from './routes/verification';

// Import socket handlers
import { setupSocketHandlers } from './socket/socketHandlers';

// Import middleware
import { errorHandler } from './middleware/errorHandler';
import { authMiddleware, optionalAuthMiddleware } from './middleware/auth';
import { 
  httpsEnforcement, 
  createUserRateLimit, 
  securityHeaders, 
  requestId, 
  securityMonitoring,
  apiVersioning 
} from './middleware/security';

// Initialize Supabase client
export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceKey
);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: config.cors.origin,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Trust proxy for rate limiting and HTTPS detection
app.set('trust proxy', 1);

// HTTPS enforcement (must be first)
app.use(httpsEnforcement);

// Request ID middleware
app.use(requestId);

// Security monitoring
app.use(securityMonitoring);

// Enhanced security headers
app.use(securityHeaders);

// Security middleware with enhanced CSP
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https:', 'wss:'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", 'https:'],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: config.env === 'production' ? [] : null,
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// CORS configuration
app.use(cors({
  origin: config.cors.origin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cache-Control', 'Pragma'],
}));

// API versioning
app.use('/api', apiVersioning);

// IP-based rate limiting (fallback)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: config.env === 'production' ? 500 : 1000, // Stricter in production
  message: {
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip IP rate limiting for authenticated users (they have per-user limits)
    return !!req.user;
  }
});

app.use('/api/', limiter);

// Per-user rate limiting for authenticated endpoints
const userLimiter = createUserRateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Per user limit
  message: 'Too many requests for this user, please try again later.',
  skipSuccessfulRequests: false,
  skipFailedRequests: false
});

// Stricter rate limiting for auth routes (IP-based)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: config.env === 'production' ? 50 : 100, // Stricter in production
  message: {
    error: 'Too many authentication attempts, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-user rate limiting for auth routes
const authUserLimiter = createUserRateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Very strict for auth
  message: 'Too many authentication attempts for this user, please try again later.',
});

app.use('/api/auth/', authLimiter);
app.use('/api/auth/', authUserLimiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Compression middleware
app.use(compression());

// Cache control middleware - prevent caching of API responses
app.use('/api', (req, res, next) => {
  // Set cache control headers to prevent caching
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Last-Modified': new Date().toUTCString(),
    'ETag': false
  });
  next();
});

// Logging middleware
app.use(morgan('combined', {
  stream: {
    write: (message: string) => {
      logger.info(message.trim());
    },
  },
}));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: config.env,
  });
});

// API Routes with per-user rate limiting for authenticated endpoints
app.use('/api/auth', authRoutes);
app.use('/api/users', optionalAuthMiddleware, userRoutes);
app.use('/api/posts', authMiddleware, userLimiter, postRoutes);
app.use('/api/comments', authMiddleware, userLimiter, commentRoutes);
app.use('/api/messages', authMiddleware, userLimiter, messageRoutes);
app.use('/api/conversations', authMiddleware, userLimiter, conversationRoutes);
app.use('/api/messaging', authMiddleware, userLimiter, messagingRoutes);
app.use('/api/notifications', authMiddleware, userLimiter, notificationRoutes);
app.use('/api/tokens', authMiddleware, userLimiter, tokenRoutes);
app.use('/api/upload', authMiddleware, userLimiter, uploadRoutes);
app.use('/api/admin', authMiddleware, userLimiter, adminRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/memberships', membershipRoutes);
app.use('/api/livestreams', livestreamRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/discover', discoverRoutes);
app.use('/api/migration', authMiddleware, userLimiter, migrationRoutes);
app.use('/api/verification', verificationRoutes);

// Socket.IO setup
const socketHandlers = setupSocketHandlers(io);

// Store socket handlers in app locals for access in routes
app.locals.socketHandlers = socketHandlers;

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    message: `The requested route ${req.originalUrl} does not exist.`,
  });
});

// Global error handler
app.use(errorHandler);

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
  });
});

// Unhandled promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Uncaught exception handler
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

const PORT = config.port || 3000;

server.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
  logger.info(`📱 Environment: ${config.env}`);
  logger.info(`🔗 Health check: http://localhost:${PORT}/health`);
});

export { io };
export default app;
