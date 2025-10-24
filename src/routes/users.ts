import express, { Request, Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { authenticateToken } from '../middleware/auth';
import { validate, validateQuery, validateParams } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import Joi from 'joi';

const router = express.Router();

// Validation schemas
const getUsersQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  search: Joi.string().max(100),
  role: Joi.string().valid('athlete', 'coach', 'expert'),
  sportsCategory: Joi.string(),
  location: Joi.string(),
  verified: Joi.boolean()
});

const userIdSchema = Joi.object({
  id: Joi.string().uuid().required()
});

const usernameSchema = Joi.object({
  username: Joi.string().min(3).max(50).required()
});

const followUserSchema = Joi.object({
  userId: Joi.string().uuid().required()
});

const suggestedUsersQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(20).default(5),
  exclude_following: Joi.boolean().default(true),
  sports_category: Joi.string()
});

// Profile share schemas
const shareProfileSchema = Joi.object({
  username: Joi.string().min(3).max(50).required(),
  message: Joi.string().max(200).allow('', null)
});

const listSharesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20)
});


// Get all users with filtering and pagination
router.get('/', validateQuery(getUsersQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 20,
    search,
    role,
    sportsCategory,
    location,
    verified
  } = req.query as any;

  const offset = (page - 1) * limit;

  let query = supabase
    .from('users')
    .select(`
      id,
      name,
      email,
      avatar_url,
      username,
      role,
      bio,
      location,
      sports_categories,
      is_verified,
      created_at,
      followers:user_following!followed_id(count),
      following:user_following!follower_id(count)
    `, { count: 'exact' })
    .eq('is_private', false)
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false });

  // Apply filters
  if (search) {
    query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%,bio.ilike.%${search}%`);
  }

  if (role) {
    query = query.eq('role', role);
  }

  if (sportsCategory) {
    query = query.contains('sports_categories', [sportsCategory]);
  }

  if (location) {
    query = query.ilike('location', `%${location}%`);
  }

  if (verified !== undefined) {
    query = query.eq('is_verified', verified);
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
    users,
    pagination: {
      currentPage: page,
      totalPages,
      totalUsers: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get user by username
router.get('/username/:username', validateParams(usernameSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;
  const authUserId = (req as any).user?.id;

  // First fetch basic public profile without user_tokens to avoid RLS and join errors
  const { data: userBasic, error: userBasicError } = await supabase
    .from('users')
    .select('*')
    .eq('username', username)
    .single();

  if (userBasicError || !userBasic) {
    res.status(404).json({
      success: false,
      error: 'User not found'
    });
    return;
  }

  // If requesting own profile, refetch with user_tokens using admin client
  if (authUserId && authUserId === userBasic.id) {
    const { data: userWithTokens, error: userWithTokensError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('username', username)
      .single();

    if (!userWithTokensError && userWithTokens) {
      res.json({ success: true, user: userWithTokens });
      return;
    }
  }

  const user = userBasic;

  if (!user) {
    res.status(404).json({
       success: false,
       error: 'User not found'
     });
     return;
  }

  // Check if profile is private and user is not authenticated or not following
  if (user.is_private) {
    const authUser = req.user;
    if (!authUser) {
      res.status(403).json({
           success: false,
           error: 'This profile is private'
         });
          return;
    }

    if (authUser.id !== user.id) {
      // Check if authenticated user is following this user
      const { data: following } = await supabase
        .from('user_following')
        .select('id')
        .eq('follower_id', authUser.id)
        .eq('following_id', user.id)
        .single();

      if (!following) {
        res.status(403).json({
          success: false,
          error: 'This profile is private'
        });
        return;
      }
    }
  }

  res.json({
    success: true,
    user
  });
}));

// Get suggested users
router.get('/suggested', authenticateToken, validateQuery(suggestedUsersQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = (req as any).user?.id;
  const {
    limit = 5,
    exclude_following = true,
    sports_category = null
  } = req.query as any;

  // Normalize inputs
  const parsedLimit = Number(limit) || 5;
  const excludeFollowing = String(exclude_following).toLowerCase() !== 'false';
  const normalizedSport = sports_category
    ? String(sports_category).trim().toLowerCase().replace(/\s+/g, '-')
    : null;

  let { data, error } = await supabaseAdmin.rpc('get_suggested_users', {
    current_user_id: userId,
    limit_param: parsedLimit,
    sports_category_param: normalizedSport,
    exclude_following: excludeFollowing
  });

  // Fallback: if no results with sport filter, try without sport filter
  if (!error && Array.isArray(data) && data.length === 0 && normalizedSport) {
    const retry = await supabaseAdmin.rpc('get_suggested_users', {
      current_user_id: userId,
      limit_param: parsedLimit,
      sports_category_param: null,
      exclude_following: excludeFollowing
    });
    data = retry.data;
    error = retry.error;
  }

  if (error) {
    console.error('get_suggested_users RPC error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch suggested users',
      error: error.message || error
    });
    return;
  }

  res.json({
    success: true,
    users: Array.isArray(data) ? data : []
  });
}));

// Follow a user
router.post('/follow', authenticateToken, validate(followUserSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.body;
  const followerId = req.user!.id;

  if (followerId === userId) {
    res.status(400).json({
       success: false,
       error: 'Cannot follow yourself'
     });
     return;
  }

  // Check if user exists
  const { data: userToFollow, error: userError } = await supabase
    .from('users')
    .select('id, name')
    .eq('id', userId)
    .single();

  if (userError || !userToFollow) {
    res.status(404).json({
      success: false,
      error: 'User not found'
    });
    return;
  }

  // Check if already following
  const { data: existingFollow } = await supabase
    .from('user_following')
    .select('follower_id')
    .eq('follower_id', followerId)
    .eq('following_id', userId)
    .single();

  if (existingFollow) {
    res.status(400).json({
      success: false,
      error: 'Already following this user'
    });
    return;
  }

  // Create follow relationship
  const { error: followError } = await supabaseAdmin
    .from('user_following')
    .insert({
      follower_id: followerId,
      following_id: userId,
      created_at: new Date().toISOString()
    });

  if (followError) {
    res.status(400).json({
      success: false,
      error: 'Failed to follow user'
    });
    return;
  }

  // Get follower's name for notification
  const { data: followerData } = await supabase
    .from('users')
    .select('name')
    .eq('id', followerId)
    .single();

  // Create notification for the followed user
  const { data: notif } = await supabaseAdmin
    .from('notifications')
    .insert({
      user_id: userId,
      type: 'follow',
      title: 'New Follower',
      message: `${followerData?.name || 'Someone'} started following you`,
      data: { followerId },
      from_user_id: followerId,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  const socketHandlers = (req as any).app?.locals?.socketHandlers;
  if (socketHandlers && notif) {
    socketHandlers.sendNotificationToUser(userId, notif);
  }

  res.json({
    success: true,
    message: `Now following ${userToFollow.name}`
  });
}));

// Get user by ID
router.get('/:id', validateParams(userIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const authUserId = (req as any).user?.id;
  const isSelf = !!authUserId && authUserId === id;

  if (isSelf) {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !user) {
      res.status(404).json({
         success: false,
         error: 'User not found'
       });
       return;
    }

    // Private profile checks remain the same below
    if (user.is_private) {
      const authUser = req.user;
      if (!authUser) {
        res.status(403).json({ success: false, error: 'This profile is private' });
        return;
      }
      if (authUser.id !== id) {
        const { data: following } = await supabase
          .from('user_following')
          .select('id')
          .eq('follower_id', authUser.id)
          .eq('following_id', id)
          .single();
        if (!following) {
          res.status(403).json({ success: false, error: 'This profile is private' });
          return;
        }
      }
    }

    res.json({ success: true, user });
    return;
  }

  // Not self: fetch without tokens to avoid RLS issues
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !user) {
    res.status(404).json({
       success: false,
       error: 'User not found'
     });
     return;
  }

  // Check if profile is private and user is not authenticated or not following
  if (user.is_private) {
    const authUser = req.user;
    if (!authUser) {
      res.status(403).json({
           success: false,
           error: 'This profile is private'
         });
          return;
    }

    if (authUser.id !== id) {
      // Check if authenticated user is following this user
      const { data: following } = await supabase
        .from('user_following')
        .select('id')
        .eq('follower_id', authUser.id)
        .eq('followed_id', id)
        .single();

      if (!following) {
        res.status(403).json({
          success: false,
          error: 'This profile is private'
        });
        return;
      }
    }
  }

  res.json({
    success: true,
    user
  });
}));



// Get user's posts
router.get('/:id/posts', validateParams(userIdSchema), validateQuery(getUsersQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { page = 1, limit = 20 } = req.query as any;
  const offset = (page - 1) * limit;

  const { data: posts, error, count } = await supabase
    .from('posts')
    .select(`
      *,
      author:users!author_id(
        id,
        name,
        avatar_url,
        role,
        is_verified
      ),
      likes:post_likes(count),
      shares:post_shares(count),
      comments(count)
    `, { count: 'exact' })
    .eq('author_id', id)
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false });

  if (error) {
    res.status(400).json({
       success: false,
       error: 'Failed to fetch user posts'
     });
     return;
  }

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    posts,
    pagination: {
      currentPage: page,
      totalPages,
      totalPosts: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get user's shared posts
router.get('/:id/shared-posts', validateParams(userIdSchema), validateQuery(getUsersQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { page = 1, limit = 20 } = req.query as any;
  const offset = (page - 1) * limit;

  // Get posts that this user has shared
  const { data: sharedPosts, error, count } = await supabase
    .from('post_shares')
    .select(`
      *,
      post:posts(
        *,
        author:users!author_id(
          id,
          name,
          username,
          avatar_url,
          role,
          is_verified
        ),
        likes:post_likes(count),
        shares:post_shares(count),
        comments(count)
      )
    `, { count: 'exact' })
    .eq('user_id', id)
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false });

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch shared posts'
    });
    return;
  }

  // Transform the data to match the expected format
  const posts = (sharedPosts || []).map((share: any) => ({
    ...share.post,
    sharedAt: share.created_at,
    shareId: share.id
  }));

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    posts,
    pagination: {
      currentPage: page,
      totalPages,
      totalPosts: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get user's followers
router.get('/:id/followers', validateParams(userIdSchema), validateQuery(getUsersQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { page = 1, limit = 20 } = req.query as any;
  const offset = (page - 1) * limit;

  // First get follower IDs
  const { data: followerRows, error: followIdsError, count } = await supabase
    .from('user_following')
    .select('follower_id', { count: 'exact' })
    .eq('following_id', id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (followIdsError) {
    res.status(400).json({ success: false, error: 'Failed to fetch followers' });
    return;
  }

  const followerIds = (followerRows || []).map(r => r.follower_id);

  let followers: any[] = [];
  if (followerIds.length > 0) {
    const { data: usersData, error: usersError } = await supabase
      .from('users')
      .select('id, name, username, avatar_url, role, bio, is_verified')
      .in('id', followerIds);

    if (usersError) {
      res.status(400).json({ success: false, error: 'Failed to fetch follower profiles' });
      return;
    }

    // Preserve original order by followerRows using id-index
    const idToUser = new Map((usersData || []).map(u => [u.id, u]));
    followers = followerIds.map(fid => idToUser.get(fid)).filter(Boolean) as any[];
  }

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    followers,
    pagination: {
      currentPage: page,
      totalPages,
      totalFollowers: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get user's following
router.get('/:id/following', validateParams(userIdSchema), validateQuery(getUsersQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { page = 1, limit = 20 } = req.query as any;
  const offset = (page - 1) * limit;

  // First get following IDs
  const { data: followingRows, error: followingIdsError, count } = await supabase
    .from('user_following')
    .select('following_id', { count: 'exact' })
    .eq('follower_id', id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (followingIdsError) {
    res.status(400).json({ success: false, error: 'Failed to fetch following' });
    return;
  }

  const followingIds = (followingRows || []).map(r => r.following_id);

  let following: any[] = [];
  if (followingIds.length > 0) {
    const { data: usersData, error: usersError } = await supabase
      .from('users')
      .select('id, name, username, avatar_url, role, bio, is_verified')
      .in('id', followingIds);

    if (usersError) {
      res.status(400).json({ success: false, error: 'Failed to fetch following profiles' });
      return;
    }

    const idToUser = new Map((usersData || []).map(u => [u.id, u]));
    following = followingIds.map(fid => idToUser.get(fid)).filter(Boolean) as any[];
  }

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    following,
    pagination: {
      currentPage: page,
      totalPages,
      totalFollowing: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));



// Unfollow a user
router.delete('/follow/:id', authenticateToken, validateParams(userIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id: userId } = req.params;
  const followerId = req.user!.id;

  const { error } = await supabaseAdmin
    .from('user_following')
    .delete()
    .eq('follower_id', followerId)
    .eq('following_id', userId);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to unfollow user'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Successfully unfollowed user'
  });
}));

// Check if user is following another user
router.get('/follow-status/:id', authenticateToken, validateParams(userIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id: userId } = req.params;
  const followerId = req.user!.id;

  console.log('=== FOLLOW STATUS DEBUG ===');
  console.log('Requested userId:', userId);
  console.log('Follower ID:', followerId);
  console.log('User ID type:', typeof userId);
  console.log('Follower ID type:', typeof followerId);
  console.log('Request headers:', req.headers);
  console.log('User from auth:', req.user);

  // First check if both users exist
  const [targetUserResult, followerUserResult] = await Promise.all([
    supabase.from('users').select('id, name').eq('id', userId).single(),
    supabase.from('users').select('id, name').eq('id', followerId).single()
  ]);

  if (targetUserResult.error) {
    console.log('Target user not found:', targetUserResult.error);
    res.status(404).json({
      success: false,
      error: 'Target user not found'
    });
    return;
  }

  if (followerUserResult.error) {
    console.log('Follower user not found:', followerUserResult.error);
    res.status(404).json({
      success: false,
      error: 'Follower user not found'
    });
    return;
  }

  console.log('Target user found:', targetUserResult.data);
  console.log('Follower user found:', followerUserResult.data);

  const { data: followStatus, error } = await supabase
    .from('user_following')
    .select('follower_id')
    .eq('follower_id', followerId)
    .eq('following_id', userId)
    .single();

  console.log('Follow status query result:', { followStatus, error });

  if (error && error.code !== 'PGRST116') {
    console.log('Database error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check follow status',
      details: error.message
    });
    return;
  }

  console.log('Success - isFollowing:', !!followStatus);
  console.log('========================');

  res.json({
    success: true,
    isFollowing: !!followStatus
  });
}));

// Batch check follow status for multiple users
router.post('/follow-status', authenticateToken, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const followerId = req.user!.id;
  const { userIds } = req.body as { userIds: string[] };

  if (!Array.isArray(userIds) || userIds.length === 0) {
    res.status(400).json({ success: false, error: 'userIds must be a non-empty array' });
    return;
  }

  // Fetch all following rows where following_id in provided list
  const { data, error } = await supabase
    .from('user_following')
    .select('following_id')
    .eq('follower_id', followerId)
    .in('following_id', userIds);

  if (error) {
    res.status(500).json({ success: false, error: 'Failed to check follow status' });
    return;
  }

  const followedSet = new Set((data || []).map((r: any) => r.following_id));
  const result = Object.fromEntries(userIds.map(id => [id, followedSet.has(id)]));

  res.json({ success: true, statuses: result });
}));

// Search users
router.get('/search/:query', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { query } = req.params;
  const { limit = 20 } = req.query as any;

  if (!query || query.length < 2) {
    res.status(400).json({
      success: false,
      error: 'Search query must be at least 2 characters'
    });
    return;
  }

  const { data: users, error } = await supabase
    .from('users')
    .select(`
      id,
      name,
      email,
      avatar_url,
      role,
      bio,
      location,
      sports_categories,
      is_verified
    `)
    .or(`name.ilike.%${query}%,email.ilike.%${query}%,bio.ilike.%${query}%`)
    .eq('is_private', false)
    .limit(limit)
    .order('name');

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Search failed'
    });
    return;
  }

  res.json({
    success: true,
    users: users || []
  });
}));

// Share my profile with another user by their username
router.post('/share-profile', authenticateToken, validate(shareProfileSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { username, message } = req.body as { username: string; message?: string };
  const sharerId = req.user!.id;

  // Find recipient by username
  const { data: recipient, error: recipientError } = await supabase
    .from('users')
    .select('id, name, username')
    .eq('username', username)
    .single();

  if (recipientError || !recipient) {
    res.status(404).json({
      success: false,
      error: 'Recipient not found'
    });
    return;
  }

  // Fetch sharer basic info
  const { data: sharer } = await supabase
    .from('users')
    .select('name, username')
    .eq('id', sharerId)
    .single();

  // Create notification for the recipient
  const { error: notifError } = await supabaseAdmin
    .from('notifications')
    .insert({
      user_id: recipient.id,
      type: 'profile_share',
      title: 'Profile Shared',
      message: message || `${sharer?.name || 'Someone'} shared their profile with you`,
      data: { sharerId, sharerUsername: sharer?.username || null },
      created_at: new Date().toISOString()
    });

  if (notifError) {
    res.status(400).json({ success: false, error: 'Failed to share profile' });
    return;
  }

  res.json({ success: true, message: 'Profile shared successfully' });
}));

// List received profile shares
router.get('/profile-shares/received', authenticateToken, validateQuery(listSharesQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { page = 1, limit = 20 } = req.query as any;
  const offset = (page - 1) * limit;

  const { data: notifs, error, count } = await supabase
    .from('notifications')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .eq('type', 'profile_share')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    res.status(400).json({ success: false, error: 'Failed to fetch profile shares' });
    return;
  }

  const sharerIds = Array.from(new Set((notifs || []).map(n => (n as any).data?.sharerId).filter(Boolean)));
  let sharersMap: Record<string, any> = {};
  if (sharerIds.length > 0) {
    const { data: sharers } = await supabase
      .from('users')
      .select('id, name, username, avatar_url, role, is_verified')
      .in('id', sharerIds);
    sharersMap = Object.fromEntries((sharers || []).map(u => [u.id, u]));
  }

  const items = (notifs || []).map(n => ({
    id: n.id,
    created_at: n.created_at,
    message: n.message,
    sharer: sharersMap[(n as any).data?.sharerId] || { id: (n as any).data?.sharerId, username: (n as any).data?.sharerUsername }
  }));

  const totalPages = Math.ceil((count || 0) / limit);
  res.json({ success: true, shares: items, pagination: { currentPage: page, totalPages, total: count } });
}));

// List sent profile shares
router.get('/profile-shares/sent', authenticateToken, validateQuery(listSharesQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { page = 1, limit = 20 } = req.query as any;
  const offset = (page - 1) * limit;

  const { data: notifs, error, count } = await supabase
    .from('notifications')
    .select('*', { count: 'exact' })
    .contains('data', { sharerId: userId })
    .eq('type', 'profile_share')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    res.status(400).json({ success: false, error: 'Failed to fetch sent profile shares' });
    return;
  }

  const recipientIds = Array.from(new Set((notifs || []).map(n => (n as any).user_id).filter(Boolean)));
  let recipientsMap: Record<string, any> = {};
  if (recipientIds.length > 0) {
    const { data: recipients } = await supabase
      .from('users')
      .select('id, name, username, avatar_url, role, is_verified')
      .in('id', recipientIds);
    recipientsMap = Object.fromEntries((recipients || []).map(u => [u.id, u]));
  }

  const items = (notifs || []).map(n => ({
    id: n.id,
    created_at: n.created_at,
    message: n.message,
    recipient: recipientsMap[(n as any).user_id] || { id: (n as any).user_id }
  }));

  const totalPages = Math.ceil((count || 0) / limit);
  res.json({ success: true, shares: items, pagination: { currentPage: page, totalPages, total: count } });
}));

// Get user statistics
router.get('/:id/stats', validateParams(userIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  try {
    // Get various statistics
    const [postsResult, followersResult, followingResult, tokensResult] = await Promise.all([
      supabase.from('posts').select('*', { count: 'exact', head: true }).eq('author_id', id),
      supabase.from('user_following').select('*', { count: 'exact', head: true }).eq('following_id', id),
      supabase.from('user_following').select('*', { count: 'exact', head: true }).eq('follower_id', id),
      supabase.from('user_tokens').select('*').eq('user_id', id).single()
    ]);

    // Get user's post IDs first
    const { data: userPosts } = await supabase
      .from('posts')
      .select('id')
      .eq('author_id', id);

    const postIds = userPosts?.map(post => post.id) || [];

    // Get engagement metrics for user's posts
    const [likesReceivedResult, commentsReceivedResult, sharesReceivedResult] = await Promise.all([
      postIds.length > 0 ? supabase.from('post_likes').select('id', { count: 'exact' }).in('post_id', postIds) : { count: 0 },
      postIds.length > 0 ? supabase.from('comments').select('id', { count: 'exact' }).in('post_id', postIds) : { count: 0 },
      postIds.length > 0 ? supabase.from('post_shares').select('id', { count: 'exact' }).in('post_id', postIds) : { count: 0 }
    ]);

    // Calculate engagement metrics
    const postsCount = postsResult.count || 0;
    const likesReceived = likesReceivedResult.count || 0;
    const commentsReceived = commentsReceivedResult.count || 0;
    const sharesReceived = sharesReceivedResult.count || 0;
    
    // Calculate streak (simplified - posts in last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const { count: recentPostsCount } = await supabase
      .from('posts')
      .select('id', { count: 'exact' })
      .eq('author_id', id)
      .gte('created_at', sevenDaysAgo.toISOString());

    const streakDays = Math.min(recentPostsCount || 0, 7);

    res.json({
      success: true,
      stats: {
        posts_count: postsCount,
        followers_count: followersResult.count || 0,
        following_count: followingResult.count || 0,
        likes_received: likesReceived,
        comments_received: commentsReceived,
        shares_received: sharesReceived,
        streak_days: streakDays,
        total_workouts: 0, // Placeholder - would need workout tracking
        achievements_count: 0, // Placeholder - would need achievements system
        tokens_balance: tokensResult.data?.balance || 0
      },
      recent_achievements: [] // Placeholder - would need achievements system
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user statistics'
    });
  }
}));

// Get home page dashboard data
router.get('/:id/dashboard', authenticateToken, validateParams(userIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const userId = (req as any).user?.id;

  // Verify user can access this dashboard
  if (userId !== id) {
    res.status(403).json({
      success: false,
      error: 'Access denied'
    });
    return;
  }

  try {
    // Get user stats
    const [postsResult, followersResult, followingResult, tokensResult] = await Promise.all([
      supabase.from('posts').select('*', { count: 'exact', head: true }).eq('author_id', id),
      supabase.from('user_following').select('*', { count: 'exact', head: true }).eq('following_id', id),
      supabase.from('user_following').select('*', { count: 'exact', head: true }).eq('follower_id', id),
      supabase.from('user_tokens').select('*').eq('user_id', id).single()
    ]);

    // Get user's post IDs first
    const { data: userPosts } = await supabase
      .from('posts')
      .select('id')
      .eq('author_id', id);

    const postIds = userPosts?.map(post => post.id) || [];

    // Get engagement metrics for user's posts
    const [likesReceivedResult, commentsReceivedResult, sharesReceivedResult] = await Promise.all([
      postIds.length > 0 ? supabase.from('post_likes').select('id', { count: 'exact' }).in('post_id', postIds) : { count: 0 },
      postIds.length > 0 ? supabase.from('comments').select('id', { count: 'exact' }).in('post_id', postIds) : { count: 0 },
      postIds.length > 0 ? supabase.from('post_shares').select('id', { count: 'exact' }).in('post_id', postIds) : { count: 0 }
    ]);

    // Calculate streak
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const { count: recentPostsCount } = await supabase
      .from('posts')
      .select('id', { count: 'exact' })
      .eq('author_id', id)
      .gte('created_at', sevenDaysAgo.toISOString());

    const streakDays = Math.min(recentPostsCount || 0, 7);

    // Get recent activity (last 5 posts)
    const { data: recentPosts } = await supabase
      .from('posts')
      .select(`
        id,
        content,
        created_at,
        likes:post_likes(count),
        comments(count),
        shares:post_shares(count)
      `)
      .eq('author_id', id)
      .order('created_at', { ascending: false })
      .limit(5);

    // Get today's activity stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const { count: todayPosts } = await supabase
      .from('posts')
      .select('id', { count: 'exact' })
      .eq('author_id', id)
      .gte('created_at', today.toISOString())
      .lt('created_at', tomorrow.toISOString());

    const { count: activeChats } = await supabase
      .from('conversations')
      .select('id', { count: 'exact' })
      .contains('participants', [id])
      .gte('updated_at', today.toISOString());

    const { count: upcomingEvents } = await supabase
      .from('event_registrations')
      .select('id', { count: 'exact' })
      .eq('user_id', id)
      .gte('event.start_time', today.toISOString());

    res.json({
      success: true,
      dashboard: {
        stats: {
          posts_count: postsResult.count || 0,
          followers_count: followersResult.count || 0,
          following_count: followingResult.count || 0,
          likes_received: likesReceivedResult.count || 0,
          comments_received: commentsReceivedResult.count || 0,
          shares_received: sharesReceivedResult.count || 0,
          streak_days: streakDays,
          total_workouts: 0,
          achievements_count: 0,
          tokens_balance: tokensResult.data?.balance || 0
        },
        today_stats: {
          posts_today: todayPosts || 0,
          active_chats: activeChats || 0,
          upcoming_events: upcomingEvents || 0
        },
        recent_activity: recentPosts || [],
        recent_achievements: [] // Placeholder
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard data'
    });
  }
}));

export default router;