import express, { Request, Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { validate, validateQuery, validateParams } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Validation schemas
const createLivestreamSchema = Joi.object({
  title: Joi.string().required().max(255),
  description: Joi.string().required().max(1000),
  youtubeUrl: Joi.string().uri().required(),
  thumbnailUrl: Joi.string().uri().allow(''),
  category: Joi.string().valid('coco', 'martial-arts', 'calorie-fight', 'adaptive-sports', 'unstructured-sports').required(),
  scheduledTime: Joi.date().iso().allow(null),
  isLive: Joi.boolean().default(false)
});

const updateLivestreamSchema = Joi.object({
  title: Joi.string().max(255),
  description: Joi.string().max(1000),
  youtubeUrl: Joi.string().uri(),
  thumbnailUrl: Joi.string().uri().allow(''),
  category: Joi.string().valid('coco', 'martial-arts', 'calorie-fight', 'adaptive-sports', 'unstructured-sports'),
  scheduledTime: Joi.date().iso().allow(null),
  isLive: Joi.boolean(),
  isActive: Joi.boolean()
});

const getLivestreamsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  category: Joi.string().valid('coco', 'martial-arts', 'calorie-fight', 'adaptive-sports', 'unstructured-sports'),
  isLive: Joi.boolean(),
  coachId: Joi.string().uuid(),
  sortBy: Joi.string().valid('created_at', 'scheduled_time', 'viewers_count').default('created_at'),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc')
});

const livestreamIdSchema = Joi.object({
  id: Joi.string().uuid().required()
});

// Get all livestreams
router.get('/', validateQuery(getLivestreamsQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 20,
    category,
    isLive,
    coachId,
    sortBy = 'created_at',
    sortOrder = 'desc'
  } = req.query as any;

  const offset = (page - 1) * limit;

  let query = supabase
    .from('livestreams')
    .select(`
      *,
      coach:users!user_id(
        id,
        name,
        avatar_url,
        role,
        is_verified,
        sports_categories
      )
    `, { count: 'exact' })
    .eq('is_active', true)
    .range(offset, offset + limit - 1)
    .order(sortBy, { ascending: sortOrder === 'asc' });

  // Apply filters
  if (category) {
    query = query.eq('category', category);
  }

  if (typeof isLive === 'boolean') {
    query = query.eq('is_live', isLive);
  }

  if (coachId) {
    query = query.eq('user_id', coachId);
  }

  const { data: livestreams, error, count } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch livestreams'
    });
    return;
  }

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    livestreams: livestreams || [],
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1
    }
  });
}));

// Get single livestream
router.get('/:id', validateParams(livestreamIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const { data: livestream, error } = await supabase
    .from('livestreams')
    .select(`
      *,
      coach:users!user_id(
        id,
        name,
        avatar_url,
        role,
        is_verified,
        sports_categories
      )
    `)
    .eq('id', id)
    .eq('is_active', true)
    .single();

  if (error || !livestream) {
    res.status(404).json({
      success: false,
      error: 'Livestream not found'
    });
    return;
  }

  res.json({
    success: true,
    livestream
  });
}));

// Create livestream (coaches only)
router.post('/', authenticateToken, validate(createLivestreamSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const user = req.user!;

  console.log('Creating livestream for user:', user.id, 'with role:', user.role);

  // Check if user is a coach
  if (user.role !== 'coach') {
    console.log('User is not a coach, role:', user.role);
    res.status(403).json({
      success: false,
      error: 'Only coaches can create livestreams'
    });
    return;
  }

  const {
    title,
    description,
    youtubeUrl,
    thumbnailUrl,
    category,
    scheduledTime,
    isLive
  } = req.body;

  console.log('Inserting livestream data:', {
    user_id: user.id,
    title,
    description,
    youtube_url: youtubeUrl,
    thumbnail_url: thumbnailUrl,
    category,
    scheduled_time: scheduledTime,
    is_live: isLive || false,
    started_at: isLive ? new Date().toISOString() : null
  });

  const { data: livestream, error } = await supabaseAdmin
    .from('livestreams')
    .insert({
      user_id: user.id,
      title,
      description,
      youtube_url: youtubeUrl,
      thumbnail_url: thumbnailUrl,
      category,
      scheduled_time: scheduledTime ?? null,
      is_live: isLive || false,
      started_at: isLive ? new Date().toISOString() : null
    })
    .select(`
      *,
      coach:users!user_id(
        id,
        name,
        avatar_url,
        role,
        is_verified,
        sports_categories
      )
    `)
    .single();

  if (error) {
    console.error('Database error creating livestream:', error);
    res.status(400).json({
      success: false,
      error: 'Failed to create livestream',
      details: error.message
    });
    return;
  }

  res.status(201).json({
    success: true,
    livestream
  });
}));

// Update livestream
router.put('/:id', authenticateToken, validateParams(livestreamIdSchema), validate(updateLivestreamSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  const user = req.user!;

  // Check if livestream exists and belongs to user
  const { data: existingLivestream, error: fetchError } = await supabaseAdmin
    .from('livestreams')
    .select('user_id, started_at, is_live')
    .eq('id', id)
    .single();

  if (fetchError || !existingLivestream) {
    res.status(404).json({
      success: false,
      error: 'Livestream not found'
    });
    return;
  }

  if (existingLivestream.user_id !== user.id) {
    res.status(403).json({
      success: false,
      error: 'You can only update your own livestreams'
    });
    return;
  }

  const updateData: any = { ...req.body };
  
  // Convert camelCase to snake_case for database
  if (updateData.youtubeUrl) {
    updateData.youtube_url = updateData.youtubeUrl;
    delete updateData.youtubeUrl;
  }
  if (updateData.thumbnailUrl) {
    updateData.thumbnail_url = updateData.thumbnailUrl;
    delete updateData.thumbnailUrl;
  }
  if (updateData.scheduledTime) {
    updateData.scheduled_time = updateData.scheduledTime;
    delete updateData.scheduledTime;
  }
  if (updateData.isLive !== undefined) {
    updateData.is_live = updateData.isLive;
    delete updateData.isLive;
    
    // Set started_at when going live
    if (updateData.is_live && !existingLivestream.started_at) {
      updateData.started_at = new Date().toISOString();
    }
    // Set ended_at when stopping live
    if (!updateData.is_live && existingLivestream.is_live) {
      updateData.ended_at = new Date().toISOString();
    }
  }
  if (updateData.isActive !== undefined) {
    updateData.is_active = updateData.isActive;
    delete updateData.isActive;
  }

  const { data: livestream, error } = await supabaseAdmin
    .from('livestreams')
    .update(updateData)
    .eq('id', id)
    .select(`
      *,
      coach:users!user_id(
        id,
        name,
        avatar_url,
        role,
        is_verified,
        sports_categories
      )
    `)
    .single();

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to update livestream'
    });
    return;
  }

  res.json({
    success: true,
    livestream
  });
}));

// Delete livestream
router.delete('/:id', authenticateToken, validateParams(livestreamIdSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  const user = req.user!;

  // Check if livestream exists and belongs to user
  const { data: existingLivestream, error: fetchError } = await supabaseAdmin
    .from('livestreams')
    .select('user_id')
    .eq('id', id)
    .single();

  if (fetchError || !existingLivestream) {
    res.status(404).json({
      success: false,
      error: 'Livestream not found'
    });
    return;
  }

  if (existingLivestream.user_id !== user.id) {
    res.status(403).json({
      success: false,
      error: 'You can only delete your own livestreams'
    });
    return;
  }

  const { error } = await supabaseAdmin
    .from('livestreams')
    .update({ is_active: false })
    .eq('id', id);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to delete livestream'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Livestream deleted successfully'
  });
}));

// Update viewer count
router.post('/:id/viewers', validateParams(livestreamIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { viewers } = req.body;

  if (typeof viewers !== 'number' || viewers < 0) {
    res.status(400).json({
      success: false,
      error: 'Invalid viewer count'
    });
    return;
  }

  const { data: livestream, error: fetchError } = await supabaseAdmin
    .from('livestreams')
    .select('max_viewers')
    .eq('id', id)
    .single();

  if (fetchError || !livestream) {
    res.status(404).json({
      success: false,
      error: 'Livestream not found'
    });
    return;
  }

  const updateData: any = {
    viewers_count: viewers
  };

  // Update max viewers if current count is higher
  if (viewers > (livestream.max_viewers || 0)) {
    updateData.max_viewers = viewers;
  }

  const { error } = await supabaseAdmin
    .from('livestreams')
    .update(updateData)
    .eq('id', id);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to update viewer count'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Viewer count updated successfully'
  });
}));

// Get livestreams by coach
router.get('/coach/:coachId', validateParams(Joi.object({ coachId: Joi.string().uuid().required() })), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { coachId } = req.params;

  const { data: livestreams, error } = await supabaseAdmin
    .from('livestreams')
    .select(`
      *,
      coach:users!user_id(
        id,
        name,
        avatar_url,
        role,
        is_verified,
        sports_categories
      )
    `)
    .eq('user_id', coachId)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch coach livestreams'
    });
    return;
  }

  res.json({
    success: true,
    livestreams: livestreams || []
  });
}));

export default router;