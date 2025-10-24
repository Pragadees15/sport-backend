import express, { Request, Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { authenticateToken, optionalAuthMiddleware } from '../middleware/auth';
import { validate, validateQuery, validateParams } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Validation schemas
const createPostSchema = Joi.object({
  content: Joi.string().required().max(2000),
  mediaUrls: Joi.array().items(Joi.string().uri())
});

const updatePostSchema = Joi.object({
  content: Joi.string().max(2000)
});

const getPostsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  authorId: Joi.string().uuid(),
  search: Joi.string().max(100),
  sortBy: Joi.string().valid('created_at').default('created_at'),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc')
});

const postIdSchema = Joi.object({
  id: Joi.string().uuid().required()
});

const trendingPostsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(50).default(20),
  timeframe: Joi.string().valid('today', 'week', 'month').default('week'),
  sportsCategory: Joi.string()
});

// Get all posts with filtering and pagination
router.get('/', optionalAuthMiddleware, validateQuery(getPostsQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 20,
    authorId,
    search,
    sortBy = 'created_at',
    sortOrder = 'desc'
  } = req.query as any;

  const offset = (page - 1) * limit;

  let query = supabase
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
      comments(count),
      user_liked:post_likes(
        user_id
      ),
      user_shared:post_shares(
        user_id
      )
    `, { count: 'exact' })
    .range(offset, offset + limit - 1);

  // Apply filters

  if (authorId) {
    query = query.eq('author_id', authorId);
  }

  if (search) {
    query = query.ilike('content', `%${search}%`);
  }

  // Apply sorting
  if (sortBy === 'created_at') {
    query = query.order('created_at', { ascending: sortOrder === 'asc' });
  } else {
    // For likes, shares, comments we need to use a different approach
    query = query.order('created_at', { ascending: false }); // Default fallback
  }

  const { data: posts, error, count } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch posts'
    });
    return;
  }

  // Process posts to add user interaction flags
  const processedPosts = posts?.map(post => ({
    ...post,
    likes: post.likes?.[0]?.count || 0,
    shares: post.shares?.[0]?.count || 0,
    comments: post.comments?.[0]?.count || 0,
    isLikedByUser: req.user ? post.user_liked?.some((like: any) => like.user_id === req.user!.id) : false,
    isSharedByUser: req.user ? post.user_shared?.some((share: any) => share.user_id === req.user!.id) : false,
    user_liked: undefined, // Remove from response
    user_shared: undefined // Remove from response
  }));

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    posts: processedPosts,
    pagination: {
      currentPage: page,
      totalPages,
      totalPosts: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Home feed via Supabase RPC get_home_feed
router.get('/home', authenticateToken, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 10,
    sortBy = 'created_at',
    sortOrder = 'desc',
    feedFilter = 'all-sports'
  } = req.query as any;

  const userId = req.user!.id;

  const { data, error } = await supabaseAdmin.rpc('get_home_feed', {
    user_id_param: userId,
    feed_filter: String(feedFilter),
    page: Number(page),
    page_size: Number(limit),
    sort_by: String(sortBy),
    sort_order: String(sortOrder)
  });

  if (error) {
    console.error('get_home_feed RPC error:', error);
    res.status(400).json({ success: false, error: 'Failed to fetch home feed', details: error.message || error });
    return;
  }

  const rows = Array.isArray(data) ? data : [];

  // Determine which posts the current user has liked/shared
  const postIds = rows.map(r => r.post_id);
  const authorIds = Array.from(new Set(rows.map(r => r.author_id).filter(Boolean)));
  let likedSet = new Set<string>();
  let sharedSet = new Set<string>();
  let authorMeta = new Map<string, { is_verified: boolean; role: string | null }>();
  if (postIds.length > 0) {
    const [{ data: likedRows }, { data: sharedRows }, { data: authorRows }] = await Promise.all([
      supabaseAdmin.from('post_likes').select('post_id').eq('user_id', userId).in('post_id', postIds),
      supabaseAdmin.from('post_shares').select('post_id').eq('user_id', userId).in('post_id', postIds),
      authorIds.length > 0
        ? supabaseAdmin.from('users').select('id, is_verified, role').in('id', authorIds)
        : Promise.resolve({ data: [] as any })
    ]);
    likedSet = new Set((likedRows || []).map((r: any) => r.post_id));
    sharedSet = new Set((sharedRows || []).map((r: any) => r.post_id));
    (authorRows || []).forEach((u: any) => {
      authorMeta.set(u.id, { is_verified: !!u.is_verified, role: u.role || null });
    });
  }
  const total = rows.length > 0 ? Number(rows[0].total_count || 0) : 0;
  const hasMore = rows.length > 0 ? Boolean(rows[0].has_more) : false;

  // Map rows to posts format expected by frontend
  const posts = rows.map(r => ({
    id: r.post_id,
    author_id: r.author_id,
    content: r.content,
    media_urls: r.media_urls,
    likes_count: r.likes_count,
    shares_count: r.shares_count,
    comments_count: r.comments_count,
    created_at: r.created_at,
    updated_at: r.updated_at,
    isLikedByUser: likedSet.has(r.post_id),
    isSharedByUser: sharedSet.has(r.post_id),
    author: {
      id: r.author_id,
      name: r.author_name,
      username: r.author_username,
      avatar_url: r.author_avatar_url,
      primary_sport: r.author_primary_sport,
      // Enrich with verification and role for badges
      is_verified: authorMeta.get(r.author_id || '')?.is_verified ?? false,
      role: authorMeta.get(r.author_id || '')?.role ?? null
    }
  }));

  res.json({
    success: true,
    posts,
    total,
    hasMore
  });
}));

// Get single post by ID
router.get('/:id', optionalAuthMiddleware, validateParams(postIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const { data: post, error } = await supabase
    .from('posts')
    .select(`
      *,
      author:users!author_id(
        id,
        name,
        avatar_url,
        role,
        bio,
        is_verified
      ),
      likes:post_likes(count),
      shares:post_shares(count),
      comments(
        *,
        author:users!author_id(
          id,
          name,
          avatar_url,
          role,
          is_verified
        )
      )
    `)
    .eq('id', id)
    .single();

  if (error || !post) {
    res.status(404).json({
      success: false,
      error: 'Post not found'
    });
    return;
  }

  // Check if user has liked/shared the post
  let isLikedByUser = false;
  let isSharedByUser = false;

  if (req.user) {
    const [likeResult, shareResult] = await Promise.all([
      supabaseAdmin.from('post_likes').select('id').eq('post_id', id).eq('user_id', req.user.id).single(),
    supabaseAdmin.from('post_shares').select('id').eq('post_id', id).eq('user_id', req.user.id).single()
    ]);

    isLikedByUser = !!likeResult.data;
    isSharedByUser = !!shareResult.data;
  }

  res.json({
    success: true,
    post: {
      ...post,
      likes: post.likes?.[0]?.count || 0,
      shares: post.shares?.[0]?.count || 0,
      isLikedByUser,
      isSharedByUser
    }
  });
}));

// Create new post
router.post('/', authenticateToken, validate(createPostSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    content,
    mediaUrls
  } = req.body;

  // Only coaches can create posts
  if (req.user!.role !== 'coach') {
    res.status(403).json({
      success: false,
      error: 'Only coaches can create posts'
    });
    return;
  }

  const postId = uuidv4();

  const { data: post, error } = await supabaseAdmin
    .from('posts')
    .insert({
      id: postId,
      author_id: req.user!.id,
      content,
      media_urls: mediaUrls,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .select(`
      *,
      author:users!author_id(
        id,
        name,
        avatar_url,
        role,
        is_verified
      )
    `)
    .single();

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to create post'
    });
    return;
  }

  // Award tokens for creating post
  await supabaseAdmin.rpc('add_user_tokens', {
    user_id_param: req.user!.id,
    amount_param: 10
  });

  res.status(201).json({
    success: true,
    message: 'Post created successfully',
    post
  });
}));

// Update post
router.put('/:id', authenticateToken, validateParams(postIdSchema), validate(updatePostSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const updates = {
    ...req.body,
    updated_at: new Date().toISOString()
  };

  // Check if user owns the post
  const { data: existingPost, error: fetchError } = await supabaseAdmin
    .from('posts')
    .select('author_id')
    .eq('id', id)
    .single();

  if (fetchError || !existingPost) {
    res.status(404).json({
      success: false,
      error: 'Post not found'
    });
    return;
  }

  if (existingPost.author_id !== req.user!.id) {
    res.status(403).json({
      success: false,
      error: 'Not authorized to update this post'
    });
    return;
  }

  const { data: updatedPost, error } = await supabaseAdmin
    .from('posts')
    .update(updates)
    .eq('id', id)
    .select(`
      *,
      author:users!author_id(
        id,
        name,
        avatar_url,
        role,
        is_verified
      )
    `)
    .single();

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to update post'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Post updated successfully',
    post: updatedPost
  });
}));

// Delete post
router.delete('/:id', authenticateToken, validateParams(postIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  // Check if user owns the post
  const { data: existingPost, error: fetchError } = await supabaseAdmin
    .from('posts')
    .select('author_id')
    .eq('id', id)
    .single();

  if (fetchError || !existingPost) {
    res.status(404).json({
      success: false,
      error: 'Post not found'
    });
    return;
  }

  if (existingPost.author_id !== req.user!.id) {
    res.status(403).json({
      success: false,
      error: 'Not authorized to delete this post'
    });
    return;
  }

  const { error } = await supabaseAdmin
    .from('posts')
    .delete()
    .eq('id', id);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to delete post'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Post deleted successfully'
  });
}));

// Like/Unlike post
router.post('/:id/like', authenticateToken, validateParams(postIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id: postId } = req.params;
  const userId = req.user!.id;

  // Check if post exists
  const { data: post, error: postError } = await supabaseAdmin
    .from('posts')
    .select('id, author_id')
    .eq('id', postId)
    .single();

  if (postError || !post) {
    res.status(404).json({
      success: false,
      error: 'Post not found'
    });
    return;
  }

  // Check if already liked
  const { data: existingLike } = await supabaseAdmin
    .from('post_likes')
    .select('id')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .single();

  if (existingLike) {
    // Unlike the post
    const { error: unlikeError } = await supabaseAdmin
      .from('post_likes')
      .delete()
      .eq('post_id', postId)
      .eq('user_id', userId);

    if (unlikeError) {
      res.status(400).json({
        success: false,
        error: 'Failed to unlike post'
      });
      return;
    }

    if (!unlikeError) {
      // Recalculate likes_count and persist
      const { count: likesCount } = await supabaseAdmin
        .from('post_likes')
        .select('id', { count: 'exact', head: true })
        .eq('post_id', postId);
      await supabaseAdmin
        .from('posts')
        .update({ likes_count: likesCount || 0, updated_at: new Date().toISOString() })
        .eq('id', postId);
    }

    res.json({
      success: true,
      message: 'Post unliked successfully',
      liked: false
    });
    return;
  } else {
    // Like the post
    const { error: likeError } = await supabaseAdmin
      .from('post_likes')
      .insert({
        post_id: postId,
        user_id: userId,
        created_at: new Date().toISOString()
      });

    if (likeError) {
      res.status(400).json({
        success: false,
        error: 'Failed to like post'
      });
      return;
    }

    // Recalculate likes_count and persist
    const { count: likesCount } = await supabaseAdmin
      .from('post_likes')
      .select('id', { count: 'exact', head: true })
      .eq('post_id', postId);
    await supabaseAdmin
      .from('posts')
      .update({ likes_count: likesCount || 0, updated_at: new Date().toISOString() })
      .eq('id', postId);

    // Create notification for post author (if not self-like)
    if (post.author_id !== userId) {
      // Get user's name for notification
      const { data: userData } = await supabaseAdmin
        .from('users')
        .select('name')
        .eq('id', userId)
        .single();

      const { data: notif } = await supabaseAdmin
        .from('notifications')
        .insert({
          user_id: post.author_id,
          type: 'like',
          title: 'Post Liked',
          message: `${userData?.name || 'Someone'} liked your post`,
          data: { postId, userId },
          from_user_id: userId,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      const socketHandlers = req.app.locals.socketHandlers;
      if (socketHandlers && notif) {
        socketHandlers.sendNotificationToUser(post.author_id, notif);
      }
    }

    // Award tokens for engagement
    await supabaseAdmin.rpc('add_user_tokens', {
      user_id_param: userId,
      amount_param: 1
    });

    res.json({
      success: true,
      message: 'Post liked successfully',
      liked: true
    });
    return;
  }
}));

// Share/Unshare post
router.post('/:id/share', authenticateToken, validateParams(postIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id: postId } = req.params;
  const userId = req.user!.id;

  // Check if post exists
  const { data: post, error: postError } = await supabaseAdmin
    .from('posts')
    .select('id, author_id')
    .eq('id', postId)
    .single();

  if (postError || !post) {
    res.status(404).json({
      success: false,
      error: 'Post not found'
    });
    return;
  }

  // Check if already shared
  const { data: existingShare } = await supabaseAdmin
    .from('post_shares')
    .select('id')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .single();

  if (existingShare) {
    // Unshare the post
    const { error: unshareError } = await supabaseAdmin
      .from('post_shares')
      .delete()
      .eq('post_id', postId)
      .eq('user_id', userId);

    if (unshareError) {
      res.status(400).json({
        success: false,
        error: 'Failed to unshare post'
      });
      return;
    }

    if (!unshareError) {
      // Recalculate shares_count and persist
      const { count: sharesCount } = await supabaseAdmin
        .from('post_shares')
        .select('id', { count: 'exact', head: true })
        .eq('post_id', postId);
      await supabaseAdmin
        .from('posts')
        .update({ shares_count: sharesCount || 0, updated_at: new Date().toISOString() })
        .eq('id', postId);
    }

    res.json({
      success: true,
      message: 'Post unshared successfully',
      shared: false
    });
    return;
  } else {
    // Share the post
    const { error: shareError } = await supabaseAdmin
      .from('post_shares')
      .insert({
        post_id: postId,
        user_id: userId,
        created_at: new Date().toISOString()
      });

    if (shareError) {
      res.status(400).json({
        success: false,
        error: 'Failed to share post'
      });
      return;
    }

    // Recalculate shares_count and persist
    const { count: sharesCount } = await supabaseAdmin
      .from('post_shares')
      .select('id', { count: 'exact', head: true })
      .eq('post_id', postId);
    await supabaseAdmin
      .from('posts')
      .update({ shares_count: sharesCount || 0, updated_at: new Date().toISOString() })
      .eq('id', postId);

    // Create notification for post author (if not self-share)
    if (post.author_id !== userId) {
      // Get user's name for notification
      const { data: userData } = await supabaseAdmin
        .from('users')
        .select('name')
        .eq('id', userId)
        .single();

      const { data: notif2 } = await supabaseAdmin
        .from('notifications')
        .insert({
          user_id: post.author_id,
          type: 'share',
          title: 'Post Shared',
          message: `${userData?.name || 'Someone'} shared your post`,
          data: { postId, userId },
          from_user_id: userId,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      const socketHandlers2 = req.app.locals.socketHandlers;
      if (socketHandlers2 && notif2) {
        socketHandlers2.sendNotificationToUser(post.author_id, notif2);
      }
    }

    // Award tokens for sharing
    await supabaseAdmin.rpc('add_user_tokens', {
      user_id_param: userId,
      amount_param: 5
    });

    res.json({
      success: true,
      message: 'Post shared successfully',
      shared: true
    });
    return;
  }
}));

// Get trending posts
router.get('/trending/posts', optionalAuthMiddleware, validateQuery(trendingPostsQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { limit = 20, timeframe = 'week', sportsCategory } = req.query as any;

  // Calculate date based on timeframe
  const cutoffDate = new Date();
  switch (timeframe) {
    case 'today':
      cutoffDate.setHours(0, 0, 0, 0);
      break;
    case 'week':
      cutoffDate.setDate(cutoffDate.getDate() - 7);
      break;
    case 'month':
      cutoffDate.setDate(cutoffDate.getDate() - 30);
      break;
  }

  let query = supabase
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
    `)
    .gte('created_at', cutoffDate.toISOString())
    .limit(limit);


  const { data: posts, error } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch trending posts'
    });
    return;
  }

  // Process posts to extract count values and sort by engagement score
  const processedPosts = posts?.map(post => ({
    ...post,
    likes: post.likes?.[0]?.count || 0,
    shares: post.shares?.[0]?.count || 0,
    comments: post.comments?.[0]?.count || 0
  }));

  const sortedPosts = processedPosts?.sort((a, b) => {
    const scoreA = (a.likes || 0) + (a.shares || 0) + (a.comments || 0);
    const scoreB = (b.likes || 0) + (b.shares || 0) + (b.comments || 0);
    return scoreB - scoreA;
  });

  res.json({
    success: true,
    posts: sortedPosts || []
  });
}));

export default router;