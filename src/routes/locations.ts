import express, { Request, Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { authenticateToken, optionalAuthMiddleware } from '../middleware/auth';
import { validate, validateQuery, validateParams } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Validation schemas
const checkInSchema = Joi.object({
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
  locationName: Joi.string().max(200),
  activity: Joi.string().valid('coco', 'martial-arts', 'calorie-fight', 'adaptive-sports', 'unstructured-sports').required(),
  duration: Joi.number().integer().min(1).max(1440).required(), // in minutes, max 24 hours
  notes: Joi.string().max(500)
});

const createSafeLocationSchema = Joi.object({
  name: Joi.string().required().max(200),
  description: Joi.string().allow('').max(500),
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
  address: Joi.string().allow('').max(300),
  category: Joi.string().valid('gym', 'park', 'sports-center', 'martial-arts-dojo', 'community-center', 'other').required(),
  amenities: Joi.array().items(Joi.string()).default([]),
  safetyFeatures: Joi.array().items(Joi.string()).default([]),
  operatingHours: Joi.object().default({}),
  contactInfo: Joi.object().default({}),
  imageUrls: Joi.array().items(Joi.string()).default([])
});

const updateSafeLocationSchema = Joi.object({
  name: Joi.string().max(200),
  description: Joi.string().max(500),
  latitude: Joi.number().min(-90).max(90),
  longitude: Joi.number().min(-180).max(180),
  address: Joi.string().max(300),
  category: Joi.string().valid('gym', 'park', 'sports-center', 'martial-arts-dojo', 'community-center', 'other'),
  amenities: Joi.array().items(Joi.string()),
  safetyFeatures: Joi.array().items(Joi.string()),
  operatingHours: Joi.object({
    monday: Joi.object({ open: Joi.string(), close: Joi.string() }),
    tuesday: Joi.object({ open: Joi.string(), close: Joi.string() }),
    wednesday: Joi.object({ open: Joi.string(), close: Joi.string() }),
    thursday: Joi.object({ open: Joi.string(), close: Joi.string() }),
    friday: Joi.object({ open: Joi.string(), close: Joi.string() }),
    saturday: Joi.object({ open: Joi.string(), close: Joi.string() }),
    sunday: Joi.object({ open: Joi.string(), close: Joi.string() })
  }),
  contactInfo: Joi.object({
    phone: Joi.string(),
    email: Joi.string().email(),
    website: Joi.string().uri()
  }),
  imageUrls: Joi.array().items(Joi.string().uri()),
  isActive: Joi.boolean(),
  isVerified: Joi.boolean()
});

const markSafeSchema = Joi.object({
  safetyFeatures: Joi.array().items(Joi.string()).required()
});

const getCheckInsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  activity: Joi.string().valid('coco', 'martial-arts', 'calorie-fight', 'adaptive-sports', 'unstructured-sports'),
  startDate: Joi.date().iso(),
  endDate: Joi.date().iso(),
  userId: Joi.string().uuid(),
  sortBy: Joi.string().valid('created_at', 'duration').default('created_at'),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc')
});

const getSafeLocationsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  category: Joi.string().valid('gym', 'park', 'sports-center', 'martial-arts-dojo', 'community-center', 'other'),
  latitude: Joi.number().min(-90).max(90),
  longitude: Joi.number().min(-180).max(180),
  radius: Joi.number().min(0.1).max(100).default(10), // in kilometers
  isVerified: Joi.boolean(),
  search: Joi.string().max(100),
  sortBy: Joi.string().valid('created_at', 'name', 'distance').default('created_at'),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc')
});

const getHeatMapQuerySchema = Joi.object({
  activity: Joi.string().valid('coco', 'martial-arts', 'calorie-fight', 'adaptive-sports', 'unstructured-sports'),
  startDate: Joi.date().iso(),
  endDate: Joi.date().iso(),
  bounds: Joi.alternatives().try(
    Joi.object({
      north: Joi.number().min(-90).max(90).required(),
      south: Joi.number().min(-90).max(90).required(),
      east: Joi.number().min(-180).max(180).required(),
      west: Joi.number().min(-180).max(180).required()
    }),
    Joi.string().custom((value, helpers) => {
      try {
        const parsed = JSON.parse(value);
        const boundsSchema = Joi.object({
          north: Joi.number().min(-90).max(90).required(),
          south: Joi.number().min(-90).max(90).required(),
          east: Joi.number().min(-180).max(180).required(),
          west: Joi.number().min(-180).max(180).required()
        });
        const { error } = boundsSchema.validate(parsed);
        if (error) {
          return helpers.error('any.invalid');
        }
        return parsed;
      } catch (e) {
        return helpers.error('any.invalid');
      }
    })
  )
});

const locationIdSchema = Joi.object({
  id: Joi.string().uuid().required()
});

const activeUsersLocationIdSchema = Joi.object({
  id: Joi.string().required() // Accept both UUID and coordinate-based IDs
});

// Check in to a location
router.post('/checkin', authenticateToken, validate(checkInSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    latitude,
    longitude,
    locationName,
    activity,
    duration,
    notes
  } = req.body;
  const userId = req.user!.id;

  const checkInId = uuidv4();

  // Get the JWT token from the request header
  const authHeader = req.headers.authorization;
  const token = authHeader?.substring(7); // Remove 'Bearer ' prefix

  // Create an authenticated Supabase client for this request
  const { createClient } = require('@supabase/supabase-js');
  const authenticatedSupabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    }
  );

  // Create check-in record with authenticated client
  const { data: checkIn, error } = await authenticatedSupabase
    .from('location_checkins')
    .insert({
      id: checkInId,
      user_id: userId,
      latitude,
      longitude,
      location_name: locationName,
      activity,
      duration,
      notes,
      checked_in_at: new Date().toISOString()
    })
    .select(`
      *,
      user:users(
        id,
        name,
        avatar_url
      )
    `)
    .single();

  if (error) {
    console.log('Database error during check-in:', error);
    console.log('Check-in data that failed:', {
      id: checkInId,
      user_id: userId,
      latitude,
      longitude,
      location_name: locationName,
      activity,
      duration,
      notes
    });
    res.status(400).json({
      success: false,
      error: 'Failed to create check-in',
      details: error.message
    });
    return;
  }

  // Update or create heat map data
  const gridSize = 0.01; // Approximately 1km grid
  const gridLat = Math.floor(latitude / gridSize) * gridSize;
  const gridLng = Math.floor(longitude / gridSize) * gridSize;

  // Check if heat map entry exists for this grid cell and activity
  const { data: existingHeatMap } = await supabaseAdmin
    .from('heatmap_data')
    .select('*')
    .eq('grid_lat', gridLat)
    .eq('grid_lng', gridLng)
    .eq('activity', activity)
    .single();

  if (existingHeatMap) {
    // Update existing heat map data
    await supabaseAdmin
      .from('heatmap_data')
      .update({
        intensity: existingHeatMap.intensity + 1,
        total_duration: existingHeatMap.total_duration + duration,
        last_activity: new Date().toISOString()
      })
      .eq('id', existingHeatMap.id);
  } else {
    // Create new heat map data
    await supabaseAdmin
      .from('heatmap_data')
      .insert({
        id: uuidv4(),
        grid_lat: gridLat,
        grid_lng: gridLng,
        activity,
        intensity: 1,
        total_duration: duration,
        last_activity: new Date().toISOString()
      });
  }

  // Award tokens for check-in
  const tokenReward = Math.floor(Math.min(duration * 0.5, 50)); // integer tokens as required by RPC
  await supabase.rpc('add_user_tokens', {
    user_id_param: userId,
    amount_param: tokenReward
  });

  // Record the transaction
  await supabase
    .from('token_transactions')
    .insert({
      to_user_id: userId,
      amount: tokenReward,
      type: 'earned',
      description: `Check-in reward for ${activity} activity (${duration} minutes)`
    });

  // Get user details for broadcasting
  const { data: userData } = await supabase
    .from('users')
    .select('name')
    .eq('id', userId)
    .single();

  // Notify socket handlers about the check-in for real-time updates
  const socketHandlers = req.app.locals.socketHandlers;
  if (socketHandlers && locationName) {
    // Create a location ID from coordinates for consistent room naming
    const locationId = `${Math.round(latitude * 10000)}_${Math.round(longitude * 10000)}`;
    
    // Broadcast check-in event to location room
    socketHandlers.broadcastToLocation(locationId, 'userCheckedIn', {
      checkIn,
      user: {
        id: userId,
        name: userData?.name || 'Unknown User'
      },
      tokensEarned: tokenReward,
      timestamp: new Date().toISOString()
    });
  }

  res.status(201).json({
    success: true,
    message: 'Check-in recorded successfully',
    checkIn,
    tokensEarned: tokenReward
  });
}));

// Get user's check-ins
router.get('/checkins', authenticateToken, validateQuery(getCheckInsQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 20,
    activity,
    startDate,
    endDate,
    userId,
    sortBy = 'created_at',
    sortOrder = 'desc'
  } = req.query as any;

  const offset = (page - 1) * limit;
  const targetUserId = userId || req.user!.id;

  // Check if user can view other user's check-ins
  if (userId && userId !== req.user!.id && req.user!.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'You can only view your own check-ins'
    });
    return;
  }

  // Use admin client to bypass RLS safely while enforcing user access on server
  let query = supabaseAdmin
    .from('location_checkins')
    .select(`
      *,
      user:users(
        id,
        name,
        avatar_url
      )
    `, { count: 'exact' })
    .eq('user_id', targetUserId)
    .range(offset, offset + limit - 1)
    .order(sortBy === 'created_at' ? 'checked_in_at' : sortBy, { ascending: sortOrder === 'asc' });

  // Apply filters
  if (activity) {
    query = query.eq('activity', activity);
  }

  if (startDate) {
    query = query.gte('checked_in_at', startDate);
  }

  if (endDate) {
    query = query.lte('checked_in_at', endDate);
  }

  const { data: checkIns, error, count } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch check-ins'
    });
    return;
  }

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    checkIns: checkIns || [],
    pagination: {
      currentPage: page,
      totalPages,
      totalCheckIns: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get safe locations
router.get('/safe-locations', optionalAuthMiddleware, validateQuery(getSafeLocationsQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 20,
    category,
    latitude,
    longitude,
    radius = 10,
    isVerified,
    search,
    sortBy = 'created_at',
    sortOrder = 'desc'
  } = req.query as any;

  const offset = (page - 1) * limit;

  let query = supabase
    .from('safe_locations')
    .select(`
      *,
      created_by:users!created_by(
        id,
        name,
        avatar_url
      )
    `, { count: 'exact' })
    .eq('is_active', true)
    .range(offset, offset + limit - 1);

  // Apply filters
  if (category) {
    query = query.eq('category', category);
  }

  if (typeof isVerified === 'boolean') {
    query = query.eq('is_verified', isVerified);
  }

  if (search) {
    query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%,address.ilike.%${search}%`);
  }

  // Handle location-based filtering and sorting
  if (latitude && longitude) {
    if (sortBy === 'distance') {
      // Use PostGIS distance calculation if available, otherwise use simple calculation
      query = query.order('latitude', { ascending: true }); // Fallback ordering
    } else {
      query = query.order(sortBy, { ascending: sortOrder === 'asc' });
    }
  } else {
    query = query.order(sortBy, { ascending: sortOrder === 'asc' });
  }

  const { data: locations, error, count } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch safe locations'
    });
    return;
  }

  // Calculate distances if user location is provided
  let locationsWithDistance = locations || [];
  if (latitude && longitude && locations) {
    locationsWithDistance = locations.map(location => {
      const distance = calculateDistance(
        latitude,
        longitude,
        location.latitude,
        location.longitude
      );
      return {
        ...location,
        distance: Math.round(distance * 100) / 100 // Round to 2 decimal places
      };
    });

    // Filter by radius
    locationsWithDistance = locationsWithDistance.filter(location => location.distance <= radius);

    // Sort by distance if requested
    if (sortBy === 'distance') {
      locationsWithDistance.sort((a, b) => 
        sortOrder === 'asc' ? a.distance - b.distance : b.distance - a.distance
      );
    }
  }

  // If authenticated, annotate which locations the current user has already verified
  if (req.user && locationsWithDistance && locationsWithDistance.length > 0) {
    try {
      const locationIds = locationsWithDistance.map((l: any) => l.id);
      const { data: verifiedRows } = await supabaseAdmin
        .from('safe_location_verifications')
        .select('location_id')
        .eq('user_id', req.user.id)
        .in('location_id', locationIds);
      const verifiedSet = new Set((verifiedRows || []).map((r: any) => r.location_id));
      locationsWithDistance = locationsWithDistance.map((l: any) => ({
        ...l,
        userHasVerified: verifiedSet.has(l.id)
      }));
    } catch (e) {
      // Non-fatal: skip annotation on errors
    }
  }

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    locations: locationsWithDistance,
    pagination: {
      currentPage: page,
      totalPages,
      totalLocations: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get single safe location
router.get('/safe-locations/:id', optionalAuthMiddleware, validateParams(locationIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const { data: location, error } = await supabase
    .from('safe_locations')
    .select(`
      *,
      created_by:users!created_by(
        id,
        name,
        avatar_url,
        role
      )
    `)
    .eq('id', id)
    .single();

  if (error || !location) {
    res.status(404).json({
      success: false,
      error: 'Safe location not found'
    });
    return;
  }

  res.json({
    success: true,
    location
  });
}));

// Create safe location
router.post('/safe-locations', authenticateToken, validate(createSafeLocationSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    name,
    description,
    latitude,
    longitude,
    address,
    category,
    amenities,
    safetyFeatures,
    operatingHours,
    contactInfo,
    imageUrls
  } = req.body;
  const userId = req.user!.id;

  const locationId = uuidv4();

  const insertData = {
    id: locationId,
    name,
    description: description || null,
    latitude,
    longitude,
    address: address || null,
    category,
    amenities: amenities || [],
    safety_features: safetyFeatures || [],
    operating_hours: operatingHours || {},
    contact_info: contactInfo || {},
    image_urls: imageUrls || [],
    created_by: userId,
    is_active: true,
    is_verified: false
  };

  // Use service role client to bypass RLS for location creation
  const { createClient } = require('@supabase/supabase-js');
  const serviceRoleClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
  
  const { data: location, error } = await serviceRoleClient
    .from('safe_locations')
    .insert(insertData)
    .select(`
      *,
      created_by:users!created_by(
        id,
        name,
        avatar_url
      )
    `)
    .single();

  if (error) {
    console.error('Error creating safe location:', error);
    res.status(400).json({
      success: false,
      error: 'Failed to create safe location'
    });
    return;
  }

  // Award tokens for contributing a location
  await supabase.rpc('add_user_tokens', {
    user_id_param: userId,
    amount_param: 25
  });

  // Record the transaction
  await supabase
    .from('token_transactions')
    .insert({
      to_user_id: userId,
      amount: 25,
      type: 'earned',
      description: `Added safe location: ${name}`
    });

  res.status(201).json({
    success: true,
    message: 'Safe location created successfully',
    location,
    tokensEarned: 25
  });
}));

// Update safe location
router.put('/safe-locations/:id', authenticateToken, validateParams(locationIdSchema), validate(updateSafeLocationSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const updates = {
    ...req.body,
    updated_at: new Date().toISOString()
  };

  // Convert camelCase to snake_case for database
  if (updates.safetyFeatures) {
    updates.safety_features = updates.safetyFeatures;
    delete updates.safetyFeatures;
  }
  if (updates.operatingHours) {
    updates.operating_hours = updates.operatingHours;
    delete updates.operatingHours;
  }
  if (updates.contactInfo) {
    updates.contact_info = updates.contactInfo;
    delete updates.contactInfo;
  }
  if (updates.imageUrls) {
    updates.image_urls = updates.imageUrls;
    delete updates.imageUrls;
  }
  if (updates.isActive !== undefined) {
    updates.is_active = updates.isActive;
    delete updates.isActive;
  }
  if (updates.isVerified !== undefined) {
    updates.is_verified = updates.isVerified;
    delete updates.isVerified;
  }

  // Check if location exists and user can edit it
  const { data: existingLocation, error: fetchError } = await supabase
    .from('safe_locations')
    .select('created_by')
    .eq('id', id)
    .single();

  if (fetchError || !existingLocation) {
    res.status(404).json({
      success: false,
      error: 'Safe location not found'
    });
    return;
  }

  if (existingLocation.created_by !== req.user!.id && req.user!.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'You can only update locations you created'
    });
    return;
  }

  const { data: location, error } = await supabase
    .from('safe_locations')
    .update(updates)
    .eq('id', id)
    .select(`
      *,
      created_by:users!created_by(
        id,
        name,
        avatar_url
      )
    `)
    .single();

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to update safe location'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Safe location updated successfully',
    location
  });
}));

// Delete safe location
router.delete('/safe-locations/:id', authenticateToken, validateParams(locationIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  // Check if location exists and user can delete it
  const { data: existingLocation, error: fetchError } = await supabase
    .from('safe_locations')
    .select('created_by')
    .eq('id', id)
    .single();

  if (fetchError || !existingLocation) {
    res.status(404).json({
      success: false,
      error: 'Safe location not found'
    });
    return;
  }

  if (existingLocation.created_by !== req.user!.id && req.user!.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'You can only delete locations you created'
    });
    return;
  }

  const { error } = await supabase
    .from('safe_locations')
    .delete()
    .eq('id', id);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to delete safe location'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Safe location deleted successfully'
  });
}));

// Mark an existing safe location as safe (merge safety features)
router.post('/safe-locations/:id/mark-safe', authenticateToken, validateParams(locationIdSchema), validate(markSafeSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { safetyFeatures } = req.body as { safetyFeatures: string[] };
  const userId = req.user!.id;

  // Fetch existing location with admin client to bypass RLS while enforcing logic server-side
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('safe_locations')
    .select('id, safety_features, name, verifications_count')
    .eq('id', id)
    .single();

  if (fetchErr || !existing) {
    res.status(404).json({ success: false, error: 'Safe location not found' });
    return;
  }

  const currentFeatures: string[] = Array.isArray(existing.safety_features) ? existing.safety_features : [];
  const incoming: string[] = Array.isArray(safetyFeatures) ? safetyFeatures : [];
  const merged = Array.from(new Set([...
    currentFeatures.map(String), ...incoming.map(String)
  ]));

  const { data: updated, error: updErr } = await supabaseAdmin
    .from('safe_locations')
    .update({ safety_features: merged, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();

  if (updErr) {
    res.status(400).json({ success: false, error: 'Failed to update safety features' });
    return;
  }

  // Check if user already verified this location
  const { data: existingVerification } = await supabaseAdmin
    .from('safe_location_verifications')
    .select('user_id')
    .eq('location_id', id)
    .eq('user_id', userId)
    .maybeSingle();

  let tokensEarned = 0;
  if (!existingVerification) {
    // Insert verification row and increment count
    await supabaseAdmin
      .from('safe_location_verifications')
      .insert({ location_id: id, user_id: userId });

    await supabaseAdmin
      .from('safe_locations')
      .update({ verifications_count: ((existing as any).verifications_count || 0) + 1, updated_at: new Date().toISOString() })
      .eq('id', id);

    // Award tokens once per user per location
    tokensEarned = 5;
    await supabase.rpc('add_user_tokens', { user_id_param: userId, amount_param: tokensEarned });
    await supabase.from('token_transactions').insert({ to_user_id: userId, amount: tokensEarned, type: 'earned', description: `Marked safe: ${existing.name}` });
  }

  res.json({ success: true, message: 'Safety features updated', location: updated, tokensEarned });
}));

// Unmark (unsafe) an existing safe location by current user
router.post('/safe-locations/:id/mark-unsafe', authenticateToken, validateParams(locationIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const userId = req.user!.id;

  // Ensure location exists
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('safe_locations')
    .select('id, name, verifications_count')
    .eq('id', id)
    .single();

  if (fetchErr || !existing) {
    res.status(404).json({ success: false, error: 'Safe location not found' });
    return;
  }

  // Delete verification if exists
  await supabaseAdmin
    .from('safe_location_verifications')
    .delete()
    .eq('location_id', id)
    .eq('user_id', userId);

  // Decrement verifications_count but not below zero
  const current = (existing as any).verifications_count || 0;
  const next = current > 0 ? current - 1 : 0;
  await supabaseAdmin
    .from('safe_locations')
    .update({ verifications_count: next, updated_at: new Date().toISOString() })
    .eq('id', id);

  res.json({ success: true, message: 'Safety verification removed', verifications: next });
}));

// Get heat map data
router.get('/heatmap', optionalAuthMiddleware, validateQuery(getHeatMapQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    activity,
    startDate,
    endDate,
    bounds
  } = req.query as any;

  // Bounds is now parsed by the validation middleware
  const parsedBounds = bounds;

  let query = supabase
    .from('heatmap_data')
    .select('*');

  // Apply filters
  if (activity) {
    query = query.eq('activity', activity);
  }

  if (startDate) {
    query = query.gte('last_activity', startDate);
  }

  if (endDate) {
    query = query.lte('last_activity', endDate);
  }

  if (parsedBounds) {
    query = query
      .gte('grid_lat', parsedBounds.south)
      .lte('grid_lat', parsedBounds.north)
      .gte('grid_lng', parsedBounds.west)
      .lte('grid_lng', parsedBounds.east);
  }

  const { data: heatMapData, error } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch heat map data'
    });
    return;
  }

  res.json({
    success: true,
    heatMapData: heatMapData || []
  });
}));

// Get user activity statistics
router.get('/stats/user', authenticateToken, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;

  // Get total check-ins
  const { count: totalCheckIns } = await supabase
    .from('location_checkins')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  // Get total duration
  const { data: durationData } = await supabase
    .from('location_checkins')
    .select('duration')
    .eq('user_id', userId);

  const totalDuration = durationData?.reduce((sum, record) => sum + record.duration, 0) || 0;

  // Get activity breakdown
  const { data: activityData } = await supabase
    .from('location_checkins')
    .select('activity, duration')
    .eq('user_id', userId);

  const activityBreakdown = activityData?.reduce((acc, record) => {
    if (record && record.activity) {
      if (!acc[record.activity]) {
        acc[record.activity] = { count: 0, duration: 0 };
      }
      const activityStats = acc[record.activity]!;
       activityStats.count++;
       activityStats.duration += record.duration || 0;
    }
    return acc;
  }, {} as Record<string, { count: number; duration: number }>) || {};

  // Get recent check-ins
  const { data: recentCheckIns } = await supabase
    .from('location_checkins')
    .select('*')
    .eq('user_id', userId)
    .order('checked_in_at', { ascending: false })
    .limit(5);

  res.json({
    success: true,
    stats: {
      totalCheckIns: totalCheckIns || 0,
      totalDuration,
      totalHours: Math.round((totalDuration / 60) * 100) / 100,
      activityBreakdown,
      recentCheckIns: recentCheckIns || []
    }
  });
}));

// Helper function to calculate distance between two points
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Radius of the Earth in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // Distance in kilometers
  return distance;
}

// Get active users at locations (requires socket handlers to be available)
router.get('/active-users/:id', optionalAuthMiddleware, validateParams(activeUsersLocationIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id: locationId } = req.params;
  
  // Get socket handlers from app locals (set during server initialization)
  const socketHandlers = req.app.locals.socketHandlers;
  
  if (!socketHandlers) {
    res.json({
      success: true,
      activeUsers: [],
      userCount: 0
    });
    return;
  }
  
  try {
    const activeUserIds: string[] = socketHandlers.getLocationUsers(locationId);
    const userCount: number = socketHandlers.getLocationUserCount(locationId);
    
    // Get user details for active users
    let activeUsers: any[] = [];
    if (activeUserIds.length > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, name, avatar_url, role')
        .in('id', activeUserIds);
      
      activeUsers = users || [];
    }
    
    res.json({
      success: true,
      activeUsers,
      userCount,
      locationId
    });
  } catch (error) {
    console.error('Error fetching active users:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch active users'
    });
  }
}));

export default router;