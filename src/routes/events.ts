import express, { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { authenticateToken, optionalAuthMiddleware } from '../middleware/auth';
import { validate, validateQuery, validateParams } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Validation schemas
const createEventSchema = Joi.object({
  title: Joi.string().required().max(200),
  description: Joi.string().required().max(1000),
  category: Joi.string().valid('coco', 'martial-arts', 'calorie-fight', 'adaptive-sports', 'unstructured-sports').required(),
  type: Joi.string().valid('online', 'offline', 'hybrid').required(),
  startDate: Joi.date().iso().required(),
  endDate: Joi.date().iso().min(Joi.ref('startDate')).required(),
  location: Joi.string().max(300),
  virtualLink: Joi.string().uri(),
  maxParticipants: Joi.number().integer().min(1),
  registrationFee: Joi.number().min(0).default(0),
  tokenCost: Joi.number().integer().min(0).default(0),
  requiresApproval: Joi.boolean().default(false),
  tags: Joi.array().items(Joi.string()).default([]),
  imageUrl: Joi.string().uri(),
  requirements: Joi.array().items(Joi.string()).default([])
});

const updateEventSchema = Joi.object({
  title: Joi.string().max(200),
  description: Joi.string().max(1000),
  category: Joi.string().valid('coco', 'martial-arts', 'calorie-fight', 'adaptive-sports', 'unstructured-sports'),
  type: Joi.string().valid('online', 'offline', 'hybrid'),
  startDate: Joi.date().iso(),
  endDate: Joi.date().iso(),
  location: Joi.string().max(300),
  virtualLink: Joi.string().uri(),
  maxParticipants: Joi.number().integer().min(1),
  registrationFee: Joi.number().min(0),
  tokenCost: Joi.number().integer().min(0),
  requiresApproval: Joi.boolean(),
  tags: Joi.array().items(Joi.string()),
  imageUrl: Joi.string().uri(),
  requirements: Joi.array().items(Joi.string()),
  status: Joi.string().valid('draft', 'published', 'cancelled', 'completed')
});

const getEventsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  category: Joi.string().valid('coco', 'martial-arts', 'calorie-fight', 'adaptive-sports', 'unstructured-sports'),
  type: Joi.string().valid('online', 'offline', 'hybrid'),
  status: Joi.string().valid('draft', 'published', 'cancelled', 'completed'),
  organizerId: Joi.string().uuid(),
  startDate: Joi.date().iso(),
  endDate: Joi.date().iso(),
  search: Joi.string().max(100),
  sortBy: Joi.string().valid('created_at', 'start_date', 'title', 'participants_count').default('start_date'),
  sortOrder: Joi.string().valid('asc', 'desc').default('asc')
});

const eventIdSchema = Joi.object({
  id: Joi.string().uuid().required()
});

const registerEventSchema = Joi.object({
  paymentMethod: Joi.string().valid('free', 'tokens', 'stripe').required(),
  stripePaymentIntentId: Joi.string().when('paymentMethod', {
    is: 'stripe',
    then: Joi.required(),
    otherwise: Joi.forbidden()
  }),
  message: Joi.string().max(500)
});

// Get all events with filtering and pagination
router.get('/', optionalAuthMiddleware, validateQuery(getEventsQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 20,
    category,
    type,
    status,
    organizerId,
    startDate,
    endDate,
    search,
    sortBy = 'start_date',
    sortOrder = 'asc'
  } = req.query as any;

  const offset = (page - 1) * limit;

  let query = supabase
    .from('events')
    .select(`
      *,
      organizer:users!organizer_id(
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

  if (type) {
    query = query.eq('type', type);
  }

  if (status) {
    query = query.eq('status', status);
  } else {
    // Default to published events for public view
    query = query.eq('status', 'published');
  }

  if (organizerId) {
    query = query.eq('organizer_id', organizerId);
  }

  if (startDate) {
    query = query.gte('start_date', startDate);
  }

  if (endDate) {
    query = query.lte('end_date', endDate);
  }

  if (search) {
    query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
  }

  const { data: events, error, count } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch events'
    });
    return;
  }

  // Check if user is registered for each event
  let eventsWithRegistration = events || [];
  if (req.user) {
    const eventIds = events?.map(e => e.id) || [];
    if (eventIds.length > 0) {
      const { data: registrations } = await supabase
        .from('event_registrations')
        .select('event_id, status')
        .eq('user_id', req.user.id)
        .in('event_id', eventIds);

      eventsWithRegistration = events?.map(event => ({
        ...event,
        userRegistration: registrations?.find(r => r.event_id === event.id) || null
      })) || [];
    }
  }

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    events: eventsWithRegistration,
    pagination: {
      currentPage: page,
      totalPages,
      totalEvents: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get single event by ID
router.get('/:id', optionalAuthMiddleware, validateParams(eventIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const { data: event, error } = await supabase
    .from('events')
    .select(`
      *,
      organizer:users!organizer_id(
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

  if (error || !event) {
    res.status(404).json({
      success: false,
      error: 'Event not found'
    });
    return;
  }

  // Check if user is registered
  let userRegistration = null;
  if (req.user) {
    const { data: registration } = await supabase
      .from('event_registrations')
      .select('*')
      .eq('event_id', id)
      .eq('user_id', req.user.id)
      .single();

    userRegistration = registration;
  }

  // Get participants count
  const { count: participantsCount } = await supabase
    .from('event_registrations')
    .select('*', { count: 'exact', head: true })
    .eq('event_id', id)
    .eq('status', 'approved');

  res.json({
    success: true,
    event: {
      ...event,
      userRegistration,
      participantsCount: participantsCount || 0
    }
  });
}));

// Create new event (coaches and admins only)
router.post('/', authenticateToken, validate(createEventSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  // Check if user is coach or admin
  if (!['coach', 'admin'].includes(req.user!.role)) {
    res.status(403).json({
      success: false,
      error: 'Only coaches and admins can create events'
    });
    return;
  }

  const {
    title,
    description,
    category,
    type,
    startDate,
    endDate,
    location,
    virtualLink,
    maxParticipants,
    registrationFee,
    tokenCost,
    requiresApproval,
    tags,
    imageUrl,
    requirements
  } = req.body;

  const eventId = uuidv4();

  const { data: event, error } = await supabase
    .from('events')
    .insert({
      id: eventId,
      title,
      description,
      category,
      type,
      start_date: startDate,
      end_date: endDate,
      location,
      virtual_link: virtualLink,
      organizer_id: req.user!.id,
      max_participants: maxParticipants,
      registration_fee: registrationFee,
      token_cost: tokenCost,
      requires_approval: requiresApproval,
      tags: tags || [],
      image_url: imageUrl,
      requirements: requirements || [],
      status: 'draft',
      participants_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .select(`
      *,
      organizer:users!organizer_id(
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
      error: 'Failed to create event'
    });
    return;
  }

  res.status(201).json({
    success: true,
    message: 'Event created successfully',
    event
  });
}));

// Update event (organizer only)
router.put('/:id', authenticateToken, validateParams(eventIdSchema), validate(updateEventSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const updates = {
    ...req.body,
    updated_at: new Date().toISOString()
  };

  // Convert camelCase to snake_case for database
  if (updates.startDate) {
    updates.start_date = updates.startDate;
    delete updates.startDate;
  }
  if (updates.endDate) {
    updates.end_date = updates.endDate;
    delete updates.endDate;
  }
  if (updates.virtualLink) {
    updates.virtual_link = updates.virtualLink;
    delete updates.virtualLink;
  }
  if (updates.maxParticipants) {
    updates.max_participants = updates.maxParticipants;
    delete updates.maxParticipants;
  }
  if (updates.registrationFee !== undefined) {
    updates.registration_fee = updates.registrationFee;
    delete updates.registrationFee;
  }
  if (updates.tokenCost !== undefined) {
    updates.token_cost = updates.tokenCost;
    delete updates.tokenCost;
  }
  if (updates.requiresApproval !== undefined) {
    updates.requires_approval = updates.requiresApproval;
    delete updates.requiresApproval;
  }
  if (updates.imageUrl) {
    updates.image_url = updates.imageUrl;
    delete updates.imageUrl;
  }

  // Check if event exists and user owns it
  const { data: existingEvent, error: fetchError } = await supabase
    .from('events')
    .select('organizer_id')
    .eq('id', id)
    .single();

  if (fetchError || !existingEvent) {
    res.status(404).json({
      success: false,
      error: 'Event not found'
    });
    return;
  }

  if (existingEvent.organizer_id !== req.user!.id && req.user!.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'You can only update your own events'
    });
    return;
  }

  const { data: event, error } = await supabase
    .from('events')
    .update(updates)
    .eq('id', id)
    .select(`
      *,
      organizer:users!organizer_id(
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
      error: 'Failed to update event'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Event updated successfully',
    event
  });
}));

// Delete event (organizer only)
router.delete('/:id', authenticateToken, validateParams(eventIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  // Check if event exists and user owns it
  const { data: existingEvent, error: fetchError } = await supabase
    .from('events')
    .select('organizer_id')
    .eq('id', id)
    .single();

  if (fetchError || !existingEvent) {
    res.status(404).json({
      success: false,
      error: 'Event not found'
    });
    return;
  }

  if (existingEvent.organizer_id !== req.user!.id && req.user!.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'You can only delete your own events'
    });
    return;
  }

  const { error } = await supabase
    .from('events')
    .delete()
    .eq('id', id);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to delete event'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Event deleted successfully'
  });
}));

// Register for event
router.post('/:id/register', authenticateToken, validateParams(eventIdSchema), validate(registerEventSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { paymentMethod, stripePaymentIntentId, message } = req.body;
  const userId = req.user!.id;

  // Check if event exists and is published
  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('*')
    .eq('id', id)
    .eq('status', 'published')
    .single();

  if (eventError || !event) {
    res.status(404).json({
      success: false,
      error: 'Event not found or not available for registration'
    });
    return;
  }

  // Check if event has already started
  if (new Date(event.start_date) <= new Date()) {
    res.status(400).json({
      success: false,
      error: 'Cannot register for an event that has already started'
    });
    return;
  }

  // Check if user is already registered
  const { data: existingRegistration } = await supabase
    .from('event_registrations')
    .select('*')
    .eq('event_id', id)
    .eq('user_id', userId)
    .single();

  if (existingRegistration) {
    res.status(400).json({
      success: false,
      error: 'You are already registered for this event'
    });
    return;
  }

  // Check if event is full
  if (event.max_participants) {
    const { count: currentParticipants } = await supabase
      .from('event_registrations')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', id)
      .eq('status', 'approved');

    if (currentParticipants && currentParticipants >= event.max_participants) {
      res.status(400).json({
        success: false,
        error: 'Event is full'
      });
      return;
    }
  }

  // Handle token payment
  if (paymentMethod === 'tokens' && event.token_cost > 0) {
    const { data: userTokens } = await supabase
      .from('user_tokens')
      .select('balance')
      .eq('user_id', userId)
      .single();

    if (!userTokens || userTokens.balance < event.token_cost) {
      res.status(400).json({
        success: false,
        error: 'Insufficient tokens to register for this event'
      });
      return;
    }

    // Deduct tokens
    const success = await supabase.rpc('add_user_tokens', {
      user_id: userId,
      amount: -event.token_cost,
      transaction_type: 'event_registration',
      description: `Registered for event: ${event.title}`
    });

    if (!success) {
      res.status(400).json({
        success: false,
        error: 'Failed to process token payment'
      });
      return;
    }
  }

  // Create registration
  const registrationStatus = event.requires_approval ? 'pending' : 'approved';

  const { data: registration, error: createError } = await supabase
    .from('event_registrations')
    .insert({
      id: uuidv4(),
      event_id: id,
      user_id: userId,
      payment_method: paymentMethod,
      stripe_payment_intent_id: stripePaymentIntentId || null,
      amount_paid: paymentMethod === 'stripe' ? event.registration_fee : 0,
      tokens_paid: paymentMethod === 'tokens' ? event.token_cost : 0,
      status: registrationStatus,
      message: message || null,
      registered_at: new Date().toISOString()
    })
    .select(`
      *,
      event:events(*),
      user:users(*)
    `)
    .single();

  if (createError) {
    res.status(400).json({
      success: false,
      error: 'Failed to register for event'
    });
    return;
  }

  // Update participants count if approved
  if (registrationStatus === 'approved') {
    await supabase
      .from('events')
      .update({ participants_count: event.participants_count + 1 })
      .eq('id', id);
  }

  // Create notification for organizer
  const { data: userData } = await supabase
    .from('users')
    .select('name')
    .eq('id', userId)
    .single();

  const { data: notif } = await supabase
    .from('notifications')
    .insert({
      user_id: event.organizer_id,
      type: 'event_registration',
      title: 'New Event Registration',
      message: `${userData?.name || 'Someone'} registered for your event: ${event.title}`,
      data: { eventId: id, userId, registrationId: registration.id },
      from_user_id: userId,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  const socketHandlers = (req as any).app?.locals?.socketHandlers;
  if (socketHandlers && notif) {
    socketHandlers.sendNotificationToUser(event.organizer_id, notif);
  }

  res.status(201).json({
    success: true,
    message: `Successfully registered for event${registrationStatus === 'pending' ? ' (pending approval)' : ''}`,
    registration
  });
}));

// Get event registrations (organizer only)
router.get('/:id/registrations', authenticateToken, validateParams(eventIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  // Check if user owns the event
  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('organizer_id')
    .eq('id', id)
    .single();

  if (eventError || !event) {
    res.status(404).json({
      success: false,
      error: 'Event not found'
    });
    return;
  }

  if (event.organizer_id !== req.user!.id && req.user!.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'You can only view registrations for your own events'
    });
    return;
  }

  const { data: registrations, error } = await supabase
    .from('event_registrations')
    .select(`
      *,
      user:users(
        id,
        name,
        email,
        avatar_url,
        role
      )
    `)
    .eq('event_id', id)
    .order('registered_at', { ascending: false });

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch registrations'
    });
    return;
  }

  res.json({
    success: true,
    registrations: registrations || []
  });
}));

// Approve/reject registration (organizer only)
router.put('/:id/registrations/:registrationId', authenticateToken, validateParams(Joi.object({
  id: Joi.string().uuid().required(),
  registrationId: Joi.string().uuid().required()
})), validate(Joi.object({
  status: Joi.string().valid('approved', 'rejected').required(),
  message: Joi.string().max(500)
})), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id, registrationId } = req.params;
  const { status, message } = req.body;

  // Check if user owns the event
  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('organizer_id, max_participants, participants_count')
    .eq('id', id)
    .single();

  if (eventError || !event) {
    res.status(404).json({
      success: false,
      error: 'Event not found'
    });
    return;
  }

  if (event.organizer_id !== req.user!.id && req.user!.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'You can only manage registrations for your own events'
    });
    return;
  }

  // Check if registration exists
  const { data: registration, error: regError } = await supabase
    .from('event_registrations')
    .select('*')
    .eq('id', registrationId)
    .eq('event_id', id)
    .single();

  if (regError || !registration) {
    res.status(404).json({
      success: false,
      error: 'Registration not found'
    });
    return;
  }

  // Check if event is full when approving
  if (status === 'approved' && event.max_participants) {
    if (event.participants_count >= event.max_participants) {
      res.status(400).json({
        success: false,
        error: 'Event is full'
      });
      return;
    }
  }

  // Update registration status
  const { error: updateError } = await supabase
    .from('event_registrations')
    .update({
      status,
      admin_message: message || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', registrationId);

  if (updateError) {
    res.status(400).json({
      success: false,
      error: 'Failed to update registration status'
    });
    return;
  }

  // Update participants count
  if (status === 'approved' && registration.status !== 'approved') {
    await supabase
      .from('events')
      .update({ participants_count: event.participants_count + 1 })
      .eq('id', id);
  } else if (status === 'rejected' && registration.status === 'approved') {
    await supabase
      .from('events')
      .update({ participants_count: Math.max(0, event.participants_count - 1) })
      .eq('id', id);
  }

  // Create notification for user
  const { data: notif2 } = await supabase
    .from('notifications')
    .insert({
      user_id: registration.user_id,
      type: 'event_registration_update',
      title: `Registration ${status}`,
      message: `Your registration for the event has been ${status}${message ? `: ${message}` : ''}`,
      data: { eventId: id, registrationId, status },
      from_user_id: req.user!.id,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  const socketHandlers2 = (req as any).app?.locals?.socketHandlers;
  if (socketHandlers2 && notif2) {
    socketHandlers2.sendNotificationToUser(registration.user_id, notif2);
  }

  res.json({
    success: true,
    message: `Registration ${status} successfully`
  });
}));

// Get user's event registrations
router.get('/user/my-registrations', authenticateToken, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const { data: registrations, error } = await supabase
    .from('event_registrations')
    .select(`
      *,
      event:events(
        *,
        organizer:users!organizer_id(
          id,
          name,
          avatar_url
        )
      )
    `)
    .eq('user_id', userId)
    .order('registered_at', { ascending: false });

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch user registrations'
    });
    return;
  }

  res.json({
    success: true,
    registrations: registrations || []
  });
}));

export default router;