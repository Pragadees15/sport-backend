import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { logger } from '../utils/logger';

// Extend Request interface to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: string;
        aud: string;
        exp: number;
      };
    }
  }
}

// Type for authenticated requests
export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: string;
    aud: string;
    exp: number;
    tokens?: number;
    name?: string;
  };
}

export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    
    // Debug logging removed to reduce noise
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // Debug logging removed to reduce noise
      res.status(401).json({
        error: 'Unauthorized',
        message: 'No token provided or invalid token format',
      });
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    // Debug logging removed to reduce noise

    // Verify the JWT token with Supabase
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    // Debug logging removed to reduce noise

    if (error || !user) {
      logger.warn('Authentication failed:', { error: error?.message, token: token.substring(0, 10) + '...' });
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired token',
      });
      return;
    }

    // Get user details from our database
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, email, role, is_banned, is_verified')
      .eq('id', user.id)
      .single();

    if (userError || !userData) {
      logger.error('Failed to fetch user data:', { error: userError?.message, userId: user.id });
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User not found in database',
      });
      return;
    }

    // Check if user is banned
    if (userData.is_banned) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Your account has been banned',
      });
      return;
    }

    // Update last active timestamp
    await supabaseAdmin
      .from('users')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', user.id);

    // Attach user to request object
    req.user = {
      id: userData.id,
      email: userData.email,
      role: userData.role,
      aud: user.aud,
      exp: 0, // Will be set from JWT if needed
    };

    next();
  } catch (error) {
    logger.error('Authentication middleware error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Authentication failed',
    });
    return;
  }
};

// Middleware to check if user is admin
export const adminMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
    return;
  }

  if (req.user.role !== 'admin') {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin access required',
    });
    return;
  }

  next();
};

// Middleware to check if user is admin or moderator
export const moderatorMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
    return;
  }

  if (!['admin', 'moderator'].includes(req.user.role)) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Moderator access required',
    });
    return;
  }

  next();
};

// Middleware to check if user is verified
export const verifiedMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
    return;
  }

  try {
    const { data: userData, error } = await supabaseAdmin
      .from('users')
      .select('is_verified')
      .eq('id', req.user.id)
      .single();

    if (error || !userData) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to check verification status',
      });
      return;
    }

    if (!userData.is_verified) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Account verification required',
      });
      return;
    }

    next();
  } catch (error) {
    logger.error('Verification middleware error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Verification check failed',
    });
    return;
  }
};

// Optional authentication middleware (doesn't fail if no token)
export const optionalAuthMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(); // Continue without user
    }

    const token = authHeader.substring(7);

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      return next(); // Continue without user
    }

    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, email, role, is_banned')
      .eq('id', user.id)
      .single();

    if (userError || !userData || userData.is_banned) {
      return next(); // Continue without user
    }

    req.user = {
      id: userData.id,
      email: userData.email,
      role: userData.role,
      aud: user.aud,
      exp: 0,
    };

    next();
  } catch (error) {
    logger.error('Optional auth middleware error:', error);
    next(); // Continue without user on error
  }
};

// Role-based access control middleware
export const requireRole = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as AuthenticatedRequest).user;
    
    if (!user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required'
      });
      return;
    }

    if (!allowedRoles.includes(user.role)) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Insufficient permissions'
      });
      return;
    }

    next();
  };
};

// Legacy export for backward compatibility
export const authenticateToken = authMiddleware;