import express, { Request, Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { authenticateToken } from '../middleware/auth';
import { validate, validateQuery, validateParams } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Validation schemas
const createMembershipSchema = Joi.object({
  name: Joi.string().required().max(100),
  description: Joi.string().required().max(500),
  price: Joi.number().min(0).required(),
  tokenCost: Joi.number().integer().min(0).required(),
  duration: Joi.number().integer().min(1).required(), // in days
  features: Joi.array().items(Joi.string()).required(),
  type: Joi.string().valid('basic', 'premium', 'vip').required(),
  isActive: Joi.boolean().default(true)
});

const updateMembershipSchema = Joi.object({
  name: Joi.string().max(100),
  description: Joi.string().max(500),
  price: Joi.number().min(0),
  tokenCost: Joi.number().integer().min(0),
  duration: Joi.number().integer().min(1),
  features: Joi.array().items(Joi.string()),
  type: Joi.string().valid('basic', 'premium', 'vip'),
  isActive: Joi.boolean()
});

const purchaseMembershipSchema = Joi.object({
  membershipId: Joi.string().uuid().required(),
  paymentMethod: Joi.string().valid('tokens', 'stripe').required(),
  stripePaymentIntentId: Joi.string().when('paymentMethod', {
    is: 'stripe',
    then: Joi.required(),
    otherwise: Joi.forbidden()
  })
});

const getMembershipsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  type: Joi.string().valid('basic', 'premium', 'vip'),
  isActive: Joi.boolean(),
  sortBy: Joi.string().valid('created_at', 'price', 'name').default('created_at'),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc')
});

const membershipIdSchema = Joi.object({
  id: Joi.string().uuid().required()
});

// Get all available memberships
router.get('/', validateQuery(getMembershipsQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 20,
    type,
    isActive,
    sortBy = 'created_at',
    sortOrder = 'desc'
  } = req.query as any;

  const offset = (page - 1) * limit;

  let query = supabase
    .from('memberships')
    .select('*', { count: 'exact' })
    .range(offset, offset + limit - 1)
    .order(sortBy, { ascending: sortOrder === 'asc' });

  // Apply filters
  if (type) {
    query = query.eq('type', type);
  }

  if (typeof isActive === 'boolean') {
    query = query.eq('is_active', isActive);
  }

  const { data: memberships, error, count } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch memberships'
    });
    return;
  }

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    memberships: memberships || [],
    pagination: {
      currentPage: page,
      totalPages,
      totalMemberships: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get single membership by ID
router.get('/:id', validateParams(membershipIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const { data: membership, error } = await supabase
    .from('memberships')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !membership) {
    res.status(404).json({
      success: false,
      error: 'Membership not found'
    });
    return;
  }

  res.json({
    success: true,
    membership
  });
}));

// Create new membership (admin only)
router.post('/', authenticateToken, validate(createMembershipSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  // Allow admins and coaches to create memberships
  if (req.user!.role !== 'admin' && req.user!.role !== 'coach') {
    res.status(403).json({
      success: false,
      error: 'Only admins or coaches can create memberships'
    });
    return;
  }

  const {
    name,
    description,
    price,
    tokenCost,
    duration,
    features,
    type,
    isActive
  } = req.body;

  const membershipId = uuidv4();

  const { data: membership, error } = await supabaseAdmin
    .from('memberships')
    .insert({
      id: membershipId,
      name,
      description,
      price,
      token_cost: tokenCost,
      duration,
      features,
      type,
      is_active: isActive,
      created_by: req.user!.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .select('*')
    .single();

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to create membership'
    });
    return;
  }

  res.status(201).json({
    success: true,
    message: 'Membership created successfully',
    membership
  });
}));

// Update membership (admin only)
router.put('/:id', authenticateToken, validateParams(membershipIdSchema), validate(updateMembershipSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  // Check if user is admin
  if (req.user!.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'Only admins can update memberships'
    });
    return;
  }

  const { id } = req.params;
  const updates = {
    ...req.body,
    updated_at: new Date().toISOString()
  };

  // Convert camelCase to snake_case for database
  if (updates.tokenCost !== undefined) {
    updates.token_cost = updates.tokenCost;
    delete updates.tokenCost;
  }
  if (updates.isActive !== undefined) {
    updates.is_active = updates.isActive;
    delete updates.isActive;
  }

  const { data: membership, error } = await supabaseAdmin
    .from('memberships')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to update membership'
    });
    return;
  }

  if (!membership) {
    res.status(404).json({
      success: false,
      error: 'Membership not found'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Membership updated successfully',
    membership
  });
}));

// Delete membership (admin only)
router.delete('/:id', authenticateToken, validateParams(membershipIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  // Check if user is admin
  if (req.user!.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'Only admins can delete memberships'
    });
    return;
  }

  const { id } = req.params;

  const { error } = await supabaseAdmin
    .from('memberships')
    .delete()
    .eq('id', id);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to delete membership'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Membership deleted successfully'
  });
}));

// Purchase membership
router.post('/purchase', authenticateToken, validate(purchaseMembershipSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { membershipId, paymentMethod, stripePaymentIntentId } = req.body;
  const userId = req.user!.id;

  // Block admins from purchasing memberships
  if (req.user!.role === 'admin') {
    res.status(400).json({ success: false, error: 'Admins cannot purchase memberships' });
    return;
  }

  // Check if membership exists and is active
  const { data: membership, error: membershipError } = await supabaseAdmin
    .from('memberships')
    .select('*')
    .eq('id', membershipId)
    .eq('is_active', true)
    .single();

  if (membershipError || !membership) {
    res.status(404).json({
      success: false,
      error: 'Membership not found or inactive'
    });
    return;
  }

  // Prevent duplicate purchases by TYPE (not just identical membership id)
  const nowIso = new Date().toISOString();
  const { data: existingByType } = await supabaseAdmin
    .from('user_memberships')
    .select('id, membership:memberships(type)')
    .eq('user_id', userId)
    .eq('is_active', true)
    .gte('expires_at', nowIso);

  const hasActiveSameType = Array.isArray(existingByType)
    ? existingByType.some((m: any) => m.membership?.type === membership.type)
    : false;

  if (hasActiveSameType) {
    res.status(400).json({
      success: false,
      error: 'You already have an active membership of this type'
    });
    return;
  }

  // Handle token payment
  if (paymentMethod === 'tokens') {
    // Fetch primary balance from users.tokens as the source of truth for the RPC
    const { data: userRow } = await supabaseAdmin
      .from('users')
      .select('tokens')
      .eq('id', userId)
      .single();

    // Try to fetch auxiliary user_tokens row; if missing, we'll initialize it below
    const { data: userTokens } = await supabaseAdmin
      .from('user_tokens')
      .select('balance')
      .eq('user_id', userId)
      .maybeSingle();

    const currentBalance = (userRow?.tokens ?? 0);

    if (currentBalance < membership.token_cost) {
      res.status(400).json({
        success: false,
        error: 'Insufficient tokens',
        details: { required: membership.token_cost, current: currentBalance }
      });
      return;
    }

    // Ensure user_tokens exists and is in sync (helpful for analytics/UI consistency)
    if (!userTokens) {
      await supabaseAdmin
        .from('user_tokens')
        .insert({
          user_id: userId,
          balance: currentBalance,
          total_earned: currentBalance,
          total_spent: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
    }

    // Deduct tokens
    const { data: success, error: rpcError } = await supabaseAdmin.rpc('spend_user_tokens_with_transaction', {
      user_id_param: userId,
      amount_param: membership.token_cost,
      transaction_type_param: 'spent',
      description_param: `Purchased membership: ${membership.name}`
    });

    if (rpcError || success !== true) {
      res.status(400).json({
        success: false,
        error: 'Failed to process token payment',
        details: rpcError ? rpcError.message : 'RPC returned falsy'
      });
      return;
    }
  }

  // Create user membership record
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + membership.duration);

  const { data: userMembership, error: createError } = await supabaseAdmin
    .from('user_memberships')
    .insert({
      id: uuidv4(),
      user_id: userId,
      membership_id: membershipId,
      payment_method: paymentMethod,
      stripe_payment_intent_id: stripePaymentIntentId || null,
      amount_paid: paymentMethod === 'tokens' ? 0 : membership.price,
      tokens_paid: paymentMethod === 'tokens' ? membership.token_cost : 0,
      purchased_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      is_active: true
    })
    .select(`
      *,
      membership:memberships(*)
    `)
    .single();

  if (createError) {
    // If membership creation failed after tokens were deducted, refund tokens
    if (paymentMethod === 'tokens' && membership?.token_cost > 0) {
      try {
        await supabaseAdmin.rpc('add_user_tokens', {
          user_id_param: userId,
          amount_param: membership.token_cost
        });
        await supabaseAdmin
          .from('token_transactions')
          .insert({
            to_user_id: userId,
            amount: membership.token_cost,
            type: 'earned',
            description: `Refund for failed membership purchase: ${membership.name}`,
            created_at: new Date().toISOString()
          });
      } catch (_) {
        // best-effort refund; do not mask the original error
      }
    }
    res.status(400).json({
      success: false,
      error: 'Failed to create membership record'
    });
    return;
  }

  // Create notification
  const { data: notif } = await supabase
    .from('notifications')
    .insert({
      user_id: userId,
      type: 'membership',
      title: 'Membership Purchased',
      message: `You have successfully purchased ${membership.name} membership`,
      data: { membershipId, userMembershipId: userMembership.id },
      from_user_id: req.user!.id,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  const socketHandlers = (req as any).app?.locals?.socketHandlers;
  if (socketHandlers && notif) {
    socketHandlers.sendNotificationToUser(userId, notif);
  }

  res.status(201).json({
    success: true,
    message: 'Membership purchased successfully',
    userMembership
  });
}));

// Get user's memberships
router.get('/user/my-memberships', authenticateToken, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const { data: userMemberships, error } = await supabase
    .from('user_memberships')
    .select(`
      *,
      membership:memberships(*)
    `)
    .eq('user_id', userId)
    .order('purchased_at', { ascending: false });

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch user memberships'
    });
    return;
  }

  // Separate active and expired memberships
  const now = new Date().toISOString();
  const activeMemberships = userMemberships?.filter(m => m.expires_at > now && m.is_active) || [];
  const expiredMemberships = userMemberships?.filter(m => m.expires_at <= now || !m.is_active) || [];

  res.json({
    success: true,
    activeMemberships,
    expiredMemberships,
    totalMemberships: userMemberships?.length || 0
  });
}));

// Check if user owns a specific membership (by membershipId)
router.get('/user/has/:membershipId', authenticateToken, validateParams(Joi.object({ membershipId: Joi.string().uuid().required() })), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { membershipId } = req.params;
  const userId = req.user!.id;

  // Fetch the target membership to get its type
  const { data: targetMembership } = await supabaseAdmin
    .from('memberships')
    .select('id, type, is_active')
    .eq('id', membershipId)
    .maybeSingle();

  // If membership does not exist or inactive, treat as not owned
  if (!targetMembership || targetMembership.is_active === false) {
    res.json({ success: true, hasMembership: false, hasById: false, hasByType: false });
    return;
  }

  const nowIso = new Date().toISOString();

  // Check exact id match
  const { data: ownedExact } = await supabaseAdmin
    .from('user_memberships')
    .select('id')
    .eq('user_id', userId)
    .eq('membership_id', membershipId)
    .eq('is_active', true)
    .gte('expires_at', nowIso)
    .maybeSingle();

  // Check by type match among active memberships
  const { data: ownedByTypeList } = await supabaseAdmin
    .from('user_memberships')
    .select('id, membership:memberships!inner(type, is_active)')
    .eq('user_id', userId)
    .eq('is_active', true)
    .gte('expires_at', nowIso)
    .eq('membership.is_active', true);

  const hasByType = Array.isArray(ownedByTypeList)
    ? ownedByTypeList.some((m: any) => m.membership?.type === targetMembership.type)
    : false;

  const hasById = !!ownedExact;
  res.json({ success: true, hasMembership: hasById || hasByType, hasById, hasByType });
}));

// Check if user has access to specific membership type
router.get('/user/access/:type', authenticateToken, validateParams(Joi.object({ type: Joi.string().valid('basic', 'premium', 'vip').required() })), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { type } = req.params as { type: 'basic' | 'premium' | 'vip' };
  const userId = req.user!.id;

  // Define hierarchy: higher tiers include access to lower tiers
  const allowedTypesByRequested: Record<'basic' | 'premium' | 'vip', string[]> = {
    basic: ['basic', 'premium', 'vip'],
    premium: ['premium', 'vip'],
    vip: ['vip']
  };

  const { data: activeMemberships, error } = await supabaseAdmin
    .from('user_memberships')
    .select(`id, is_active, expires_at, membership:memberships!inner(type, is_active)`) // inner join to guarantee membership rows
    .eq('user_id', userId)
    .eq('is_active', true)
    .gte('expires_at', new Date().toISOString())
    .eq('membership.is_active', true);

  if (error) {
    res.status(400).json({ success: false, error: 'Failed to check membership access' });
    return;
  }

  const allowed = allowedTypesByRequested[type];
  const matching = (activeMemberships || []).find((m: any) => allowed.includes(m.membership?.type));
  const hasAccess = !!matching;

  res.json({
    success: true,
    hasAccess,
    membership: matching || null
  });
}));

// Cancel membership (mark as inactive)
router.post('/user/cancel/:membershipId', authenticateToken, validateParams(Joi.object({ membershipId: Joi.string().uuid().required() })), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { membershipId } = req.params;
  const userId = req.user!.id;

  // Check if user owns this membership
  const { data: userMembership, error: fetchError } = await supabase
    .from('user_memberships')
    .select('*')
    .eq('id', membershipId)
    .eq('user_id', userId)
    .single();

  if (fetchError || !userMembership) {
    res.status(404).json({
      success: false,
      error: 'Membership not found'
    });
    return;
  }

  if (!userMembership.is_active) {
    res.status(400).json({
      success: false,
      error: 'Membership is already cancelled'
    });
    return;
  }

  // Mark membership as inactive
  const { error: updateError } = await supabase
    .from('user_memberships')
    .update({
      is_active: false,
      cancelled_at: new Date().toISOString()
    })
    .eq('id', membershipId);

  if (updateError) {
    res.status(400).json({
      success: false,
      error: 'Failed to cancel membership'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Membership cancelled successfully'
  });
}));

// Get membership statistics (admin only)
router.get('/admin/stats', authenticateToken, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  // Check if user is admin
  if (req.user!.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
    return;
  }

  // Get total memberships by type
  const { data: membershipStats } = await supabase
    .from('memberships')
    .select('type')
    .eq('is_active', true);

  // Get active user memberships
  const { data: activeMemberships } = await supabase
    .from('user_memberships')
    .select(`
      *,
      membership:memberships(type)
    `)
    .eq('is_active', true)
    .gte('expires_at', new Date().toISOString());

  // Get total revenue
  const { data: totalRevenue } = await supabase
    .from('user_memberships')
    .select('amount_paid, tokens_paid');

  const stats = {
    totalMemberships: membershipStats?.length || 0,
    activeMemberships: activeMemberships?.length || 0,
    membershipsByType: {
      basic: membershipStats?.filter(m => m.type === 'basic').length || 0,
      premium: membershipStats?.filter(m => m.type === 'premium').length || 0,
      vip: membershipStats?.filter(m => m.type === 'vip').length || 0
    },
    activeMembershipsByType: {
      basic: activeMemberships?.filter(m => m.membership.type === 'basic').length || 0,
      premium: activeMemberships?.filter(m => m.membership.type === 'premium').length || 0,
      vip: activeMemberships?.filter(m => m.membership.type === 'vip').length || 0
    },
    totalRevenue: {
      cash: totalRevenue?.reduce((sum, m) => sum + (m.amount_paid || 0), 0) || 0,
      tokens: totalRevenue?.reduce((sum, m) => sum + (m.tokens_paid || 0), 0) || 0
    }
  };

  res.json({
    success: true,
    stats
  });
}));

export default router;