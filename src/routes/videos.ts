import express, { Request, Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { authenticateToken, optionalAuthMiddleware } from '../middleware/auth';
import { validate, validateQuery, validateParams } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Validation schemas
const createVideoSchema = Joi.object({
  title: Joi.string().required().max(200),
  description: Joi.string().required().max(1000),
  thumbnailUrl: Joi.string().uri().required(),
  videoUrl: Joi.string().uri().required(),
  duration: Joi.number().integer().min(1).required(),
  category: Joi.string().valid('coco', 'martial-arts', 'calorie-fight', 'adaptive-sports', 'unstructured-sports').required(),
  difficulty: Joi.string().valid('beginner', 'intermediate', 'advanced').required(),
  type: Joi.string().valid('free', 'premium').default('free'),
  tokenCost: Joi.number().integer().min(0).default(0),
  tags: Joi.array().items(Joi.string()).default([])
});

const updateVideoSchema = Joi.object({
  title: Joi.string().max(200),
  description: Joi.string().max(1000),
  thumbnailUrl: Joi.string().uri(),
  videoUrl: Joi.string().uri(),
  duration: Joi.number().integer().min(1),
  category: Joi.string().valid('coco', 'martial-arts', 'calorie-fight', 'adaptive-sports', 'unstructured-sports'),
  difficulty: Joi.string().valid('beginner', 'intermediate', 'advanced'),
  type: Joi.string().valid('free', 'premium'),
  tokenCost: Joi.number().integer().min(0),
  tags: Joi.array().items(Joi.string())
});

const getVideosQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  category: Joi.string().valid('coco', 'martial-arts', 'calorie-fight', 'adaptive-sports', 'unstructured-sports'),
  difficulty: Joi.string().valid('beginner', 'intermediate', 'advanced'),
  type: Joi.string().valid('free', 'premium', 'all').default('all'),
  coachId: Joi.string().uuid(),
  search: Joi.string().max(100),
  sortBy: Joi.string().valid('created_at', 'views', 'likes', 'title').default('created_at'),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc')
});

const videoIdSchema = Joi.object({
  id: Joi.string().uuid().required()
});

// Get all videos with filtering and pagination
router.get('/', optionalAuthMiddleware, validateQuery(getVideosQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 20,
    category,
    difficulty,
    type,
    coachId,
    search,
    sortBy = 'created_at',
    sortOrder = 'desc'
  } = req.query as any;

  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from('videos')
    .select(`
      *,
      coach:users!coach_id(
        id,
        name,
        avatar_url,
        role,
        is_verified
      )
    `, { count: 'exact' })
    .range(offset, offset + limit - 1)
    .order(sortBy, { ascending: sortOrder === 'asc' });

  // Apply filters
  if (category) {
    query = query.eq('category', category);
  }

  if (difficulty) {
    query = query.eq('difficulty', difficulty);
  }

  if (type && type !== 'all') {
    query = query.eq('type', type);
  }

  if (coachId) {
    query = query.eq('coach_id', coachId);
  }

  if (search) {
    query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
  }

  const { data: videos, error, count } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch videos'
    });
    return;
  }

  // Process videos to add user interaction flags
  const processedVideos = await Promise.all(
    (videos || []).map(async (video) => {
      let isLikedByUser = false;
      
      if (req.user) {
            const { data: like } = await supabaseAdmin
              .from('video_likes')
              .select('id')
              .eq('video_id', video.id)
              .eq('user_id', req.user.id)
              .single();
        
        isLikedByUser = !!like;
      }

      return {
        ...video,
        isLiked: isLikedByUser
      };
    })
  );

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    videos: processedVideos,
    pagination: {
      currentPage: page,
      totalPages,
      totalVideos: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get single video by ID
router.get('/:id', optionalAuthMiddleware, validateParams(videoIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const { data: video, error } = await supabaseAdmin
    .from('videos')
    .select(`
      *,
      coach:users!coach_id(
        id,
        name,
        avatar_url,
        role,
        is_verified,
        bio
      )
    `)
    .eq('id', id)
    .single();

  if (error || !video) {
    res.status(404).json({
      success: false,
      error: 'Video not found'
    });
    return;
  }

  // Check if user has liked the video
  let isLikedByUser = false;
  if (req.user) {
    const { data: like } = await supabaseAdmin
      .from('video_likes')
      .select('id')
      .eq('video_id', id)
      .eq('user_id', req.user.id)
      .single();

    isLikedByUser = !!like;
  }

  res.json({
    success: true,
    video: {
      ...video,
      isLiked: isLikedByUser
    }
  });
}));

// Create new video (coaches only)
router.post('/', authenticateToken, validate(createVideoSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  // Check if user is a coach
  if (req.user!.role !== 'coach') {
    res.status(403).json({
      success: false,
      error: 'Only coaches can create videos'
    });
    return;
  }

  const {
    title,
    description,
    thumbnailUrl,
    videoUrl,
    duration,
    category,
    difficulty,
    type,
    tokenCost,
    tags
  } = req.body;


  const videoId = uuidv4();

  const videoData = {
    id: videoId,
    title,
    description,
    thumbnail_url: thumbnailUrl,
    video_url: videoUrl,
    duration,
    coach_id: req.user!.id,
    category,
    difficulty,
    type,
    token_cost: tokenCost,
    tags: tags || [],
    views_count: 0,
    likes_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data: video, error } = await supabaseAdmin
    .from('videos')
    .insert(videoData)
    .select(`
      *,
      coach:users!coach_id(
        id,
        name,
        avatar_url,
        role,
        is_verified
      )
    `)
    .single();

  if (error) {
    console.error('Video creation failed:', error);
    res.status(400).json({
      success: false,
      error: 'Failed to create video',
      details: error.message
    });
    return;
  }

  res.status(201).json({
    success: true,
    message: 'Video created successfully',
    video
  });
}));

// Update video (coach only, own videos)
router.put('/:id', authenticateToken, validateParams(videoIdSchema), validate(updateVideoSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const updates = {
    ...req.body,
    updated_at: new Date().toISOString()
  };

  // Check if video exists and user owns it
  const { data: existingVideo, error: fetchError } = await supabase
    .from('videos')
    .select('coach_id')
    .eq('id', id)
    .single();

  if (fetchError || !existingVideo) {
    res.status(404).json({
      success: false,
      error: 'Video not found'
    });
    return;
  }

  if (existingVideo.coach_id !== req.user!.id && req.user!.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'You can only update your own videos'
    });
    return;
  }

  const { data: video, error } = await supabase
    .from('videos')
    .update(updates)
    .eq('id', id)
    .select(`
      *,
      coach:users!coach_id(
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
      error: 'Failed to update video'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Video updated successfully',
    video
  });
}));

// Delete video (coach only, own videos)
router.delete('/:id', authenticateToken, validateParams(videoIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  // Check if video exists and user owns it
  const { data: existingVideo, error: fetchError } = await supabase
    .from('videos')
    .select('coach_id')
    .eq('id', id)
    .single();

  if (fetchError || !existingVideo) {
    res.status(404).json({
      success: false,
      error: 'Video not found'
    });
    return;
  }

  if (existingVideo.coach_id !== req.user!.id && req.user!.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'You can only delete your own videos'
    });
    return;
  }

  const { error } = await supabase
    .from('videos')
    .delete()
    .eq('id', id);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to delete video'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Video deleted successfully'
  });
}));

// Like/unlike video
router.post('/:id/like', authenticateToken, validateParams(videoIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const userId = req.user!.id;

  // Check if video exists
  const { data: video, error: videoError } = await supabaseAdmin
    .from('videos')
    .select('id, coach_id, likes_count')
    .eq('id', id)
    .single();

  if (videoError || !video) {
    res.status(404).json({
      success: false,
      error: 'Video not found'
    });
    return;
  }

  // Check if user already liked the video
    const { data: existingLike } = await supabaseAdmin
      .from('video_likes')
      .select('id')
      .eq('video_id', id)
      .eq('user_id', userId)
      .single();

  if (existingLike) {
    // Unlike the video
    const { error: unlikeError } = await supabaseAdmin
      .from('video_likes')
      .delete()
      .eq('video_id', id)
      .eq('user_id', userId);

    if (unlikeError) {
      res.status(400).json({
        success: false,
        error: 'Failed to unlike video'
      });
      return;
    }

    // Update video likes count
    await supabaseAdmin
      .from('videos')
      .update({ likes_count: Math.max(0, video.likes_count - 1) })
      .eq('id', id);

    res.json({
      success: true,
      message: 'Video unliked successfully',
      liked: false
    });
    return;
  } else {
    // Like the video
    const { error: likeError } = await supabaseAdmin
      .from('video_likes')
      .insert({
        user_id: userId,
        video_id: id,
        created_at: new Date().toISOString()
      });

    if (likeError) {
      res.status(400).json({
        success: false,
        error: 'Failed to like video'
      });
      return;
    }

    // Update video likes count
    await supabaseAdmin
      .from('videos')
      .update({ likes_count: video.likes_count + 1 })
      .eq('id', id);

    // Award tokens for liking the video (+2)
    try {
      await supabase.rpc('add_user_tokens', {
        user_id_param: userId,
        amount_param: 2
      });
      await supabase
        .from('token_transactions')
        .insert({
          to_user_id: userId,
          amount: 2,
          type: 'earned',
          description: `Liked video: ${id}`,
          created_at: new Date().toISOString()
        });
    } catch (e) {
      // Non-fatal: token award failure shouldn't block like action
      console.warn('Token award failed for like:', e);
    }

    // Create notification for video owner
    if (video.coach_id !== userId) {
      const { data: userData } = await supabaseAdmin
        .from('users')
        .select('name')
        .eq('id', userId)
        .single();

      const { data: notif } = await supabaseAdmin
        .from('notifications')
        .insert({
          user_id: video.coach_id,
          type: 'like',
          title: 'Video Liked',
          message: `${userData?.name || 'Someone'} liked your video`,
          data: { videoId: id, userId },
          from_user_id: userId,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      const socketHandlers = (req as any).app?.locals?.socketHandlers;
      if (socketHandlers && notif) {
        socketHandlers.sendNotificationToUser(video.coach_id, notif);
      }
    }

    res.json({
      success: true,
      message: 'Video liked successfully',
      liked: true
    });
    return;
  }
}));

// Watch video (increment view count and handle token cost)
router.post('/:id/watch', authenticateToken, validateParams(videoIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const userId = req.user!.id;

  // Check if video exists
  const { data: video, error: videoError } = await supabaseAdmin
    .from('videos')
    .select('id, coach_id, type, token_cost, views_count')
    .eq('id', id)
    .single();

  if (videoError || !video) {
    res.status(404).json({
      success: false,
      error: 'Video not found'
    });
    return;
  }

  // Enforce premium membership before allowing premium video playback
  if (video.type === 'premium') {
    const { data: activeMemberships } = await supabaseAdmin
      .from('user_memberships')
      .select('id, membership:memberships!inner(type, is_active)')
      .eq('user_id', userId)
      .eq('is_active', true)
      .gte('expires_at', new Date().toISOString())
      .eq('membership.is_active', true);

    const hasPremiumAccess = Array.isArray(activeMemberships)
      ? activeMemberships.some((m: any) => m.membership?.type === 'premium' || m.membership?.type === 'vip')
      : false;

    if (!hasPremiumAccess) {
      res.status(403).json({
        success: false,
        error: 'Premium membership required to watch this video'
      });
      return;
    }
  }

  // Check if user has already watched this video
  const { data: existingView } = await supabaseAdmin
    .from('video_views')
    .select('id')
    .eq('video_id', id)
    .eq('user_id', userId)
    .single();

  // Only increment view count if user hasn't watched this video before
  if (!existingView) {
    // At this point, for premium videos membership has been validated above.
    // We do not deduct tokens for premium videos when membership is required.
    // Record the view
    const { error: viewError } = await supabaseAdmin
      .from('video_views')
      .insert({
        video_id: id,
        user_id: userId,
        created_at: new Date().toISOString()
      });

    if (viewError) {
      console.error('Failed to record video view:', viewError);
      res.status(400).json({
        success: false,
        error: 'Failed to record video view'
      });
      return;
    }

    // Increment view count
    await supabaseAdmin
      .from('videos')
      .update({ views_count: video.views_count + 1 })
      .eq('id', id);

    // Award tokens for first-time view
    const VIEW_REWARD = 5;
    await supabase.rpc('add_user_tokens', {
      user_id_param: userId,
      amount_param: VIEW_REWARD
    });
    // Record earned transaction
    await supabase
      .from('token_transactions')
      .insert({
        to_user_id: userId,
        amount: VIEW_REWARD,
        type: 'earned',
        description: `Watched video: ${id}`,
        created_at: new Date().toISOString()
      });
  }

  res.json({
    success: true,
    message: existingView ? 'Video watch recorded (repeat view)' : 'Video watch recorded successfully',
    isNewView: !existingView
  });
}));

// Get videos by coach
router.get('/coach/:coachId', optionalAuthMiddleware, validateParams(Joi.object({ coachId: Joi.string().uuid().required() })), validateQuery(getVideosQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { coachId } = req.params;
  const { page = 1, limit = 20, sortBy = 'created_at', sortOrder = 'desc' } = req.query as any;
  const offset = (page - 1) * limit;

  const { data: videos, error, count } = await supabase
    .from('videos')
    .select(`
      *,
      coach:users!coach_id(
        id,
        name,
        avatar_url,
        role,
        is_verified
      )
    `, { count: 'exact' })
    .eq('coach_id', coachId)
    .range(offset, offset + limit - 1)
    .order(sortBy, { ascending: sortOrder === 'asc' });

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch coach videos'
    });
    return;
  }

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    videos: videos || [],
    pagination: {
      currentPage: page,
      totalPages,
      totalVideos: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

export default router;