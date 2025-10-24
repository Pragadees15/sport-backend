import express, { Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { validate, validateQuery, validateParams } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Apply admin role requirement to all routes
router.use(authenticateToken, requireRole(['admin']));

// Validation schemas
const getUsersQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().min(1).max(100),
  role: Joi.string().valid('user', 'admin', 'moderator', 'coach', 'fan', 'aspirant', 'administrator'),
  verified: Joi.boolean(),
  banned: Joi.boolean(),
  sortBy: Joi.string().valid('created_at', 'name', 'email', 'tokens', 'posts_count').default('created_at'),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc')
});

const updateUserSchema = Joi.object({
  name: Joi.string().min(2).max(100),
  email: Joi.string().email(),
  role: Joi.string().valid('user', 'admin', 'moderator', 'coach', 'fan', 'aspirant', 'administrator'),
  is_verified: Joi.boolean(),
  is_banned: Joi.boolean(),
  ban_reason: Joi.string().max(500).allow(''),
  tokens: Joi.number().integer().min(0)
});

const userIdSchema = Joi.object({
  userId: Joi.string().uuid().required()
});

const postIdSchema = Joi.object({
  postId: Joi.string().uuid().required()
});

const commentIdSchema = Joi.object({
  commentId: Joi.string().uuid().required()
});

const moderateContentSchema = Joi.object({
  action: Joi.string().valid('approve', 'reject', 'flag').required(),
  reason: Joi.string().max(500).allow('')
});

const systemAnnouncementSchema = Joi.object({
  title: Joi.string().required().max(200),
  message: Joi.string().required().max(1000),
  type: Joi.string().valid('info', 'warning', 'success', 'error').default('info'),
  targetUsers: Joi.array().items(Joi.string().uuid()).default([]),
  expiresAt: Joi.date().iso().greater('now')
});

// Dashboard statistics
router.get('/dashboard', asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  // Get user statistics
  const { count: totalUsers } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true });

  const { count: newUsersToday } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', new Date().toISOString().split('T')[0]);

  const { count: verifiedUsers } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('is_verified', true);

  const { count: bannedUsers } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('is_banned', true);

  // Get post statistics
  const { count: totalPosts } = await supabase
    .from('posts')
    .select('*', { count: 'exact', head: true });

  const { count: postsToday } = await supabase
    .from('posts')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', new Date().toISOString().split('T')[0]);

  const { count: flaggedPosts } = await supabase
    .from('posts')
    .select('*', { count: 'exact', head: true })
    .eq('is_flagged', true);

  // Get comment statistics
  const { count: totalComments } = await supabase
    .from('comments')
    .select('*', { count: 'exact', head: true });

  const { count: commentsToday } = await supabase
    .from('comments')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', new Date().toISOString().split('T')[0]);

  // Get token statistics
  const { data: tokenStats } = await supabase
    .from('users')
    .select('tokens');

  const totalTokens = tokenStats?.reduce((sum, user) => sum + (user.tokens || 0), 0) || 0;
  const avgTokensPerUser = totalUsers ? totalTokens / totalUsers : 0;

  // Get recent activity
  const { data: recentUsers } = await supabase
    .from('users')
    .select('id, name, avatar_url, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  const { data: recentPosts } = await supabase
    .from('posts')
    .select(`
      id,
      content,
      created_at,
      author:users!author_id(
        id,
        name,
        avatar_url
      )
    `)
    .order('created_at', { ascending: false })
    .limit(5);

  res.json({
    success: true,
    stats: {
      users: {
        total: totalUsers || 0,
        newToday: newUsersToday || 0,
        verified: verifiedUsers || 0,
        banned: bannedUsers || 0
      },
      posts: {
        total: totalPosts || 0,
        today: postsToday || 0,
        flagged: flaggedPosts || 0
      },
      comments: {
        total: totalComments || 0,
        today: commentsToday || 0
      },
      tokens: {
        total: totalTokens,
        averagePerUser: Math.round(avgTokensPerUser)
      }
    },
    recentActivity: {
      users: recentUsers || [],
      posts: recentPosts || []
    }
  });
}));

// Get all users with admin controls
router.get('/users', validateQuery(getUsersQuerySchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 20,
    search,
    role,
    verified,
    banned,
    sortBy = 'created_at',
    sortOrder = 'desc'
  } = req.query as any;

  const offset = (page - 1) * limit;

  let query = supabase
    .from('users')
    .select(`
      *,
      posts_count:posts(count),
      followers_count:follows!followed_id(count),
      following_count:follows!follower_id(count)
    `, { count: 'exact' })
    .range(offset, offset + limit - 1)
    .order(sortBy, { ascending: sortOrder === 'asc' });

  // Apply filters
  if (search) {
    query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%,bio.ilike.%${search}%`);
  }

  if (role) {
    query = query.eq('role', role);
  }

  if (verified !== undefined) {
    query = query.eq('is_verified', verified);
  }

  if (banned !== undefined) {
    query = query.eq('is_banned', banned);
  }

  const { data: users, error, count } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch users'
    });
    return;
  }

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    users: users || [],
    pagination: {
      currentPage: page,
      totalPages,
      totalUsers: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get single user details
router.get('/users/:userId', validateParams(userIdSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { userId } = req.params;

  const { data: user, error } = await supabase
    .from('users')
    .select(`
      *,
      posts:posts(
        id,
        content,
        media_urls,
        created_at,
        likes_count,
        comments_count,
        shares_count
      ),
      followers:follows!followed_id(
        follower:users!follower_id(
          id,
          name,
          avatar_url
        )
      ),
      following:follows!follower_id(
        followed:users!followed_id(
          id,
          name,
          avatar_url
        )
      ),
      token_transactions:token_transactions!to_user_id(
        id,
        amount,
        type,
        created_at
      )
    `)
    .eq('id', userId)
    .single();

  if (error || !user) {
    res.status(404).json({
      success: false,
      error: 'User not found'
    });
    return;
  }

  res.json({
    success: true,
    user
  });
}));

// Update user
router.put('/users/:userId', validateParams(userIdSchema), validate(updateUserSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { userId } = req.params;
  const updateData = req.body;

  // If updating email, check if it's already taken
  if (updateData.email) {
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', updateData.email)
      .neq('id', userId)
      .single();

    if (existingUser) {
      res.status(400).json({
        success: false,
        error: 'Email already in use'
      });
      return;
    }
  }

  const { data: updatedUser, error } = await supabase
    .from('users')
    .update({
      ...updateData,
      updated_at: new Date().toISOString()
    })
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to update user'
    });
    return;
  }

  // Create notification for user if they were banned/unbanned
  if (updateData.is_banned !== undefined) {
    const notificationMessage = updateData.is_banned 
      ? `Your account has been banned${updateData.ban_reason ? `: ${updateData.ban_reason}` : ''}`
      : 'Your account ban has been lifted';

    const { data: notif } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        type: 'system',
        title: updateData.is_banned ? 'Account Banned' : 'Account Unbanned',
        message: notificationMessage,
        data: { adminAction: true, adminId: req.user!.id },
        from_user_id: req.user!.id,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    const socketHandlers = (req as any).app?.locals?.socketHandlers;
    if (socketHandlers && notif) {
      socketHandlers.sendNotificationToUser(userId, notif);
    }
  }

  res.json({
    success: true,
    message: 'User updated successfully',
    user: updatedUser
  });
}));

// Delete user
router.delete('/users/:userId', validateParams(userIdSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { userId } = req.params;

  // Prevent admin from deleting themselves
  if (userId === req.user!.id) {
    res.status(400).json({
      success: false,
      error: 'Cannot delete your own account'
    });
    return;
  }

  // Use admin client to delete user from auth
  const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId as string);
  
  if (authError) {
    res.status(400).json({
      success: false,
      error: 'Failed to delete user from authentication'
    });
    return;
  }

  // Delete user from database (cascade will handle related records)
  const { error: dbError } = await supabase
    .from('users')
    .delete()
    .eq('id', userId);

  if (dbError) {
    res.status(400).json({
      success: false,
      error: 'Failed to delete user from database'
    });
    return;
  }

  res.json({
    success: true,
    message: 'User deleted successfully'
  });
}));

// Get flagged content
router.get('/flagged-content', asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { type = 'all' } = req.query as any;

  let flaggedPosts = [];
  let flaggedComments = [];

  if (type === 'all' || type === 'posts') {
    const { data: posts } = await supabase
      .from('posts')
      .select(`
        *,
        author:users!author_id(
          id,
          name,
          avatar_url,
          role
        ),
        reports:post_reports(
          id,
          reason,
          description,
          created_at,
          reporter:users!reporter_id(
            id,
            name,
            avatar_url
          )
        )
      `)
      .eq('is_flagged', true)
      .order('created_at', { ascending: false });

    flaggedPosts = posts || [];
  }

  if (type === 'all' || type === 'comments') {
    const { data: comments } = await supabase
      .from('comments')
      .select(`
        *,
        author:users!author_id(
          id,
          name,
          avatar_url,
          role
        ),
        post:posts!post_id(
          id,
          content
        ),
        reports:comment_reports(
          id,
          reason,
          description,
          created_at,
          reporter:users!reporter_id(
            id,
            name,
            avatar_url
          )
        )
      `)
      .eq('is_flagged', true)
      .order('created_at', { ascending: false });

    flaggedComments = comments || [];
  }

  res.json({
    success: true,
    flaggedContent: {
      posts: flaggedPosts,
      comments: flaggedComments
    }
  });
}));

// Moderate post
router.post('/posts/:postId/moderate', validateParams(postIdSchema), validate(moderateContentSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { postId } = req.params;
  const { action, reason } = req.body;

  const { data: post, error: fetchError } = await supabase
    .from('posts')
    .select('*, author:users!author_id(id, name)')
    .eq('id', postId)
    .single();

  if (fetchError || !post) {
    res.status(404).json({
      success: false,
      error: 'Post not found'
    });
    return;
  }

  let updateData: any = {
    moderated_at: new Date().toISOString(),
    moderated_by: req.user!.id,
    moderation_reason: reason
  };

  switch (action) {
    case 'approve':
      updateData.is_flagged = false;
      updateData.is_approved = true;
      break;
    case 'reject':
      updateData.is_flagged = false;
      updateData.is_approved = false;
      updateData.is_hidden = true;
      break;
    case 'flag':
      updateData.is_flagged = true;
      break;
  }

  const { error: updateError } = await supabase
    .from('posts')
    .update(updateData)
    .eq('id', postId);

  if (updateError) {
    res.status(400).json({
      success: false,
      error: 'Failed to moderate post'
    });
    return;
  }

  // Create notification for post author
  if (action === 'reject') {
    const { data: notif } = await supabase
      .from('notifications')
      .insert({
        user_id: post.author_id,
        type: 'system',
        title: 'Post Moderated',
        message: `Your post has been removed${reason ? `: ${reason}` : ''}`,
        data: { postId, action, reason },
        from_user_id: req.user!.id,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    const socketHandlers = (req as any).app?.locals?.socketHandlers;
    if (socketHandlers && notif) {
      socketHandlers.sendNotificationToUser(post.author_id, notif);
    }
  }

  res.json({
    success: true,
    message: `Post ${action}ed successfully`
  });
}));

// Moderate comment
router.post('/comments/:commentId/moderate', validateParams(commentIdSchema), validate(moderateContentSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { commentId } = req.params;
  const { action, reason } = req.body;

  const { data: comment, error: fetchError } = await supabase
    .from('comments')
    .select('*, author:users!author_id(id, name)')
    .eq('id', commentId)
    .single();

  if (fetchError || !comment) {
    res.status(404).json({
      success: false,
      error: 'Comment not found'
    });
    return;
  }

  let updateData: any = {
    moderated_at: new Date().toISOString(),
    moderated_by: req.user!.id,
    moderation_reason: reason
  };

  switch (action) {
    case 'approve':
      updateData.is_flagged = false;
      updateData.is_approved = true;
      break;
    case 'reject':
      updateData.is_flagged = false;
      updateData.is_approved = false;
      updateData.is_hidden = true;
      break;
    case 'flag':
      updateData.is_flagged = true;
      break;
  }

  const { error: updateError } = await supabase
    .from('comments')
    .update(updateData)
    .eq('id', commentId);

  if (updateError) {
    res.status(400).json({
      success: false,
      error: 'Failed to moderate comment'
    });
    return;
  }

  // Create notification for comment author
  if (action === 'reject') {
    const { data: notif } = await supabase
      .from('notifications')
      .insert({
        user_id: comment.author_id,
        type: 'system',
        title: 'Comment Moderated',
        message: `Your comment has been removed${reason ? `: ${reason}` : ''}`,
        data: { commentId, action, reason },
        from_user_id: req.user!.id,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    const socketHandlers = (req as any).app?.locals?.socketHandlers;
    if (socketHandlers && notif) {
      socketHandlers.sendNotificationToUser(comment.author_id, notif);
    }
  }

  res.json({
    success: true,
    message: `Comment ${action}ed successfully`
  });
}));

// Send system announcement
router.post('/announcements', validate(systemAnnouncementSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { title, message, type, targetUsers, expiresAt } = req.body;

  let userIds = targetUsers;
  
  // If no target users specified, send to all users
  if (!userIds || userIds.length === 0) {
    const { data: allUsers } = await supabase
      .from('users')
      .select('id')
      .eq('is_banned', false);
    
    userIds = allUsers?.map(user => user.id) || [];
  }

  // Create notifications for all target users
  const notifications = userIds.map((userId: string) => ({
    user_id: userId,
    type: 'system',
    title,
    message,
    data: { 
      announcement: true, 
      announcementType: type,
      adminId: req.user!.id,
      expiresAt 
    },
    created_at: new Date().toISOString()
  }));

  const { data: inserted, error } = await supabase
    .from('notifications')
    .insert(notifications.map((n: any) => ({ ...n, from_user_id: req.user!.id })))
    .select();

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to send announcement'
    });
    return;
  }

  res.json({
    success: true,
    message: `Announcement sent to ${userIds.length} users`
  });

  const socketHandlers = (req as any).app?.locals?.socketHandlers;
  if (socketHandlers && inserted) {
    inserted.forEach((n: any) => socketHandlers.sendNotificationToUser(n.user_id, n));
  }
}));

// Get system logs
router.get('/logs', asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { 
    page = 1, 
    limit = 50, 
    level = 'all',
    startDate,
    endDate 
  } = req.query as any;

  const offset = (page - 1) * limit;

  let query = supabase
    .from('system_logs')
    .select('*', { count: 'exact' })
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false });

  if (level !== 'all') {
    query = query.eq('level', level);
  }

  if (startDate) {
    query = query.gte('created_at', startDate);
  }

  if (endDate) {
    query = query.lte('created_at', endDate);
  }

  const { data: logs, error, count } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch logs'
    });
    return;
  }

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    logs: logs || [],
    pagination: {
      currentPage: page,
      totalPages,
      totalLogs: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get analytics data
router.get('/analytics', asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { period = '30d' } = req.query as any;

  let startDate = new Date();
  switch (period) {
    case '7d':
      startDate.setDate(startDate.getDate() - 7);
      break;
    case '30d':
      startDate.setDate(startDate.getDate() - 30);
      break;
    case '90d':
      startDate.setDate(startDate.getDate() - 90);
      break;
    case '1y':
      startDate.setFullYear(startDate.getFullYear() - 1);
      break;
  }

  // User growth
  const { data: userGrowth } = await supabase
    .from('users')
    .select('created_at')
    .gte('created_at', startDate.toISOString());

  // Post activity
  const { data: postActivity } = await supabase
    .from('posts')
    .select('created_at')
    .gte('created_at', startDate.toISOString());

  // Comment activity
  const { data: commentActivity } = await supabase
    .from('comments')
    .select('created_at')
    .gte('created_at', startDate.toISOString());

  // Token transactions
  const { data: tokenActivity } = await supabase
    .from('token_transactions')
    .select('created_at, amount')
    .gte('created_at', startDate.toISOString());

  // Group data by date
  const groupByDate = (data: any[], dateField: string = 'created_at') => {
    const grouped: { [key: string]: number } = {};
    data?.forEach(item => {
      if (item[dateField]) {
        const date = new Date(item[dateField]).toISOString().split('T')[0];
        if (date) {
          grouped[date] = (grouped[date] || 0) + 1;
        }
      }
    });
    return grouped;
  };

  res.json({
    success: true,
    analytics: {
      userGrowth: groupByDate(userGrowth || []),
      postActivity: groupByDate(postActivity || []),
      commentActivity: groupByDate(commentActivity || []),
      tokenActivity: {
        transactions: groupByDate(tokenActivity || []),
        volume: tokenActivity?.reduce((sum, t) => sum + t.amount, 0) || 0
      }
    }
  });
}));

export default router;