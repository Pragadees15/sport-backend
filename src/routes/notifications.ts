import express, { Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { validate, validateQuery, validateParams } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import Joi from 'joi';

const router = express.Router();

// Validation schemas
const getNotificationsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  type: Joi.string().valid('like', 'comment', 'follow', 'message', 'post', 'share', 'mention', 'system', 'event', 'achievement').optional(),
  read: Joi.boolean().optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional()
});

const notificationIdSchema = Joi.object({
  id: Joi.string().uuid().required()
});

const markReadSchema = Joi.object({
  notificationIds: Joi.array().items(Joi.string().uuid()).min(1).max(100)
});

const updatePreferencesSchema = Joi.object({
  emailNotifications: Joi.boolean(),
  pushNotifications: Joi.boolean(),
  likes: Joi.boolean(),
  comments: Joi.boolean(),
  follows: Joi.boolean(),
  messages: Joi.boolean(),
  posts: Joi.boolean(),
  shares: Joi.boolean(),
  mentions: Joi.boolean(),
  system: Joi.boolean()
});

// Get user notifications
router.get('/', authenticateToken, validateQuery(getNotificationsQuerySchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 20,
    type,
    read,
    startDate,
    endDate
  } = req.query as any;

  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from('notifications')
    .select(`
      *,
      from_user:users!from_user_id(
        id,
        name,
        avatar_url,
        role,
        is_verified
      )
    `, { count: 'exact' })
    .eq('user_id', req.user!.id)
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false });

  // Apply filters
  if (type) {
    query = query.eq('type', type);
  }

  if (read !== undefined) {
    query = query.eq('is_read', read);
  }

  if (startDate) {
    query = query.gte('created_at', startDate);
  }

  if (endDate) {
    query = query.lte('created_at', endDate);
  }

  const { data: notifications, error, count } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch notifications'
    });
    return;
  }

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    notifications: notifications || [],
    pagination: {
      currentPage: page,
      totalPages,
      totalNotifications: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get notification statistics
router.get('/stats', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  // Get total notifications
  const { count: totalCount } = await supabaseAdmin
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  // Get unread notifications
  const { count: unreadCount } = await supabaseAdmin
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);

  // Get notifications by type
  const { data: typeStats } = await supabaseAdmin
    .from('notifications')
    .select('type')
    .eq('user_id', userId);

  const typeBreakdown = typeStats?.reduce((acc: any, notification: any) => {
    acc[notification.type] = (acc[notification.type] || 0) + 1;
    return acc;
  }, {}) || {};

  // Get recent activity (last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const { count: recentCount } = await supabaseAdmin
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', sevenDaysAgo.toISOString());

  res.json({
    success: true,
    stats: {
      total: totalCount || 0,
      unread: unreadCount || 0,
      read: (totalCount || 0) - (unreadCount || 0),
      recent: recentCount || 0,
      typeBreakdown
    }
  });
}));

// Get single notification
router.get('/:id', authenticateToken, validateParams(notificationIdSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { id } = req.params;

  const { data: notification, error } = await supabaseAdmin
    .from('notifications')
    .select(`
      *,
      from_user:users!from_user_id(
        id,
        name,
        avatar_url,
        role,
        is_verified,
        bio
      )
    `)
    .eq('id', id)
    .eq('user_id', req.user!.id)
    .single();

  if (error || !notification) {
    res.status(404).json({
      success: false,
      error: 'Notification not found'
    });
    return;
  }

  res.json({
    success: true,
    notification
  });
}));

// Mark notification as read
router.patch('/:id/read', authenticateToken, validateParams(notificationIdSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { id } = req.params;

  const { data: notification, error } = await supabaseAdmin
    .from('notifications')
    .update({
      is_read: true,
      read_at: new Date().toISOString()
    })
    .eq('id', id)
    .eq('user_id', req.user!.id)
    .select()
    .single();

  if (error || !notification) {
    res.status(404).json({
      success: false,
      error: 'Notification not found'
    });
    return;
  }

  // Emit socket event (do not send as newNotification)
  const socketHandlers = req.app.locals.socketHandlers;
  if (socketHandlers) {
    socketHandlers.emitToUser(req.user!.id, 'notificationRead', id);
  }

  res.json({
    success: true,
    message: 'Notification marked as read',
    notification
  });
}));

// Mark multiple notifications as read
router.patch('/read', authenticateToken, validate(markReadSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { notificationIds } = req.body;

  const { data: notifications, error } = await supabaseAdmin
    .from('notifications')
    .update({
      is_read: true,
      read_at: new Date().toISOString()
    })
    .in('id', notificationIds)
    .eq('user_id', req.user!.id)
    .select('id');

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to mark notifications as read'
    });
    return;
  }

  const socketHandlers = req.app.locals.socketHandlers;
  if (socketHandlers && Array.isArray(notifications)) {
    notifications.forEach((n: any) => socketHandlers.emitToUser(req.user!.id, 'notificationRead', n.id));
  }

  res.json({
    success: true,
    message: `${notifications?.length || 0} notifications marked as read`
  });
}));

// Mark all notifications as read
router.patch('/read-all', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { error, count } = await supabaseAdmin
    .from('notifications')
    .update({
      is_read: true,
      read_at: new Date().toISOString()
    })
    .eq('user_id', req.user!.id)
    .eq('is_read', false);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to mark all notifications as read'
    });
    return;
  }

  res.json({
    success: true,
    message: `${count || 0} notifications marked as read`
  });
}));

// Delete notification
router.delete('/:id', authenticateToken, validateParams(notificationIdSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { id } = req.params;

  const { error } = await supabaseAdmin
    .from('notifications')
    .delete()
    .eq('id', id)
    .eq('user_id', req.user!.id);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to delete notification'
    });
    return;
  }

  const socketHandlers = req.app.locals.socketHandlers;
  if (socketHandlers) {
    socketHandlers.emitToUser(req.user!.id, 'notificationDeleted', id);
  }

  res.json({
    success: true,
    message: 'Notification deleted successfully'
  });
}));

// Delete all notifications
router.delete('/', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { error, count } = await supabaseAdmin
    .from('notifications')
    .delete()
    .eq('user_id', req.user!.id);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to delete notifications'
    });
    return;
  }

  const socketHandlers = req.app.locals.socketHandlers;
  if (socketHandlers) {
    socketHandlers.emitToUser(req.user!.id, 'notificationsCleared', {});
  }

  res.json({
    success: true,
    message: `${count || 0} notifications deleted successfully`
  });
}));

// Get unread count
router.get('/unread/count', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { count, error } = await supabaseAdmin
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', req.user!.id)
    .eq('is_read', false);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to get unread count'
    });
    return;
  }

  res.json({
    success: true,
    unreadCount: count || 0
  });
}));


// Get notification preferences
router.get('/preferences', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { data: preferences, error } = await supabaseAdmin
      .from('notification_preferences')
      .select('*')
      .eq('user_id', req.user!.id)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
      console.error('Notification preferences error:', error);
      res.status(400).json({
        success: false,
        error: 'Failed to fetch notification preferences',
        details: error.message
      });
      return;
    }

    // Normalize to camelCase for frontend
    const snake = preferences || {
      user_id: req.user!.id,
      email_notifications: true,
      push_notifications: true,
      likes: true,
      comments: true,
      follows: true,
      messages: true,
      posts: true,
      shares: true,
      mentions: true,
      system: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const camel = {
      userId: snake.user_id,
      emailNotifications: snake.email_notifications,
      pushNotifications: snake.push_notifications,
      likes: snake.likes,
      comments: snake.comments,
      follows: snake.follows,
      messages: snake.messages,
      posts: snake.posts,
      shares: snake.shares,
      mentions: snake.mentions,
      system: snake.system,
      createdAt: snake.created_at,
      updatedAt: snake.updated_at
    };

    res.json({
      success: true,
      preferences: camel
    });
  } catch (err) {
    console.error('Unexpected error in notification preferences:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
}));

// Update notification preferences
router.put('/preferences', authenticateToken, validate(updatePreferencesSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as any;

  // Map camelCase to snake_case for DB
  const mapped = {
    user_id: req.user!.id,
    email_notifications: body.emailNotifications,
    push_notifications: body.pushNotifications,
    likes: body.likes,
    comments: body.comments,
    follows: body.follows,
    messages: body.messages,
    posts: body.posts,
    shares: body.shares,
    mentions: body.mentions,
    system: body.system,
    updated_at: new Date().toISOString()
  } as any;

  const { data: updated, error } = await supabaseAdmin
    .from('notification_preferences')
    .upsert(mapped, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to update notification preferences'
    });
    return;
  }

  const response = {
    userId: updated.user_id,
    emailNotifications: updated.email_notifications,
    pushNotifications: updated.push_notifications,
    likes: updated.likes,
    comments: updated.comments,
    follows: updated.follows,
    messages: updated.messages,
    posts: updated.posts,
    shares: updated.shares,
    mentions: updated.mentions,
    system: updated.system,
    createdAt: updated.created_at,
    updatedAt: updated.updated_at
  };

  res.json({
    success: true,
    message: 'Notification preferences updated successfully',
    preferences: response
  });
}));

// Test notification (for development)
router.post('/test', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { type = 'system', title = 'Test Notification', message = 'This is a test notification' } = req.body;

  const { data: notification, error } = await supabaseAdmin
    .from('notifications')
    .insert({
      user_id: req.user!.id,
      type,
      title,
      message,
      data: { test: true },
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to create test notification'
    });
    return;
  }

  const socketHandlers = req.app.locals.socketHandlers;
  if (socketHandlers) {
    socketHandlers.sendNotificationToUser(req.user!.id, notification);
  }

  res.json({
    success: true,
    message: 'Test notification created successfully',
    notification
  });
}));

export default router;