import express, { Response } from 'express';
import { supabase } from '../config/supabase';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { validate, validateQuery, validateParams } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Helper to create an authenticated Supabase client per request (for RLS)
function createAuthedClient(req: AuthenticatedRequest) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
  const { createClient } = require('@supabase/supabase-js');
  const client = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      global: {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      }
    }
  );
  return client;
}

// Validation schemas
const transferTokensSchema = Joi.object({
  recipientId: Joi.string().uuid().required(),
  amount: Joi.number().integer().min(1).max(10000).required(),
  message: Joi.string().max(500).allow('')
});

const getTransactionsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  type: Joi.string().valid('earned', 'spent', 'transferred', 'received', 'all').default('all'),
  startDate: Joi.date().iso(),
  endDate: Joi.date().iso()
});

const userIdSchema = Joi.object({
  userId: Joi.string().uuid().required()
});

const transactionIdSchema = Joi.object({
  id: Joi.string().uuid().required()
});

const purchaseTokensSchema = Joi.object({
  packageId: Joi.string().valid('basic', 'standard', 'premium', 'ultimate').required(),
  paymentMethod: Joi.string().valid('demo', 'stripe').required(),
  stripePaymentIntentId: Joi.string().when('paymentMethod', {
    is: 'stripe',
    then: Joi.required(),
    otherwise: Joi.optional()
  })
});

// Get user's token balance
router.get('/balance', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const authed = createAuthedClient(req);
  let { data: userTokens, error } = await authed
    .from('user_tokens')
    .select('balance')
    .eq('user_id', req.user!.id)
    .single();

  // Lazy initialize if missing
  if ((error && error.code === 'PGRST116') || !userTokens) {
    // PGRST116: Row not found
    await authed
      .from('user_tokens')
      .insert({ user_id: req.user!.id, balance: 100, total_earned: 100, total_spent: 0 })
      .select('balance')
      .single();
    // Also ensure users.tokens is set
    await authed
      .from('users')
      .update({ tokens: 100 })
      .eq('id', req.user!.id);
    // Re-read
    const reread = await authed
      .from('user_tokens')
      .select('balance')
      .eq('user_id', req.user!.id)
      .single();
    userTokens = reread.data as any;
    error = reread.error as any;
  }

  res.json({
    success: true,
    balance: userTokens?.balance ?? 100
  });
}));

// Get user's token transactions
router.get('/transactions', authenticateToken, validateQuery(getTransactionsQuerySchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 20,
    type = 'all',
    startDate,
    endDate
  } = req.query as any;

  const offset = (page - 1) * limit;

  let query = supabase
    .from('token_transactions')
    .select(`
      *,
      from_user:users!from_user_id(
        id,
        name,
        avatar_url,
        role,
        is_verified
      ),
      to_user:users!to_user_id(
        id,
        name,
        avatar_url,
        role,
        is_verified
      ),
      post:posts!post_id(
        id,
        content,
        media_urls
      ),
      comment:comments!comment_id(
        id,
        content
      )
    `, { count: 'exact' })
    .or(`from_user_id.eq.${req.user!.id},to_user_id.eq.${req.user!.id}`)
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false });

  // Apply type filter
  if (type !== 'all') {
    switch (type) {
      case 'earned':
        query = query.eq('to_user_id', req.user!.id).neq('type', 'transfer');
        break;
      case 'spent':
        query = query.eq('from_user_id', req.user!.id).neq('type', 'transfer');
        break;
      case 'transferred':
        query = query.eq('from_user_id', req.user!.id).eq('type', 'transfer');
        break;
      case 'received':
        query = query.eq('to_user_id', req.user!.id).eq('type', 'transfer');
        break;
    }
  }

  // Apply date filters
  if (startDate) {
    query = query.gte('created_at', startDate);
  }

  if (endDate) {
    query = query.lte('created_at', endDate);
  }

  const { data: transactions, error, count } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch transactions'
    });
    return;
  }

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    transactions: transactions || [],
    pagination: {
      currentPage: page,
      totalPages,
      totalTransactions: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get single transaction
router.get('/transactions/:id', authenticateToken, validateParams(transactionIdSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { id } = req.params;

  const { data: transaction, error } = await supabase
    .from('token_transactions')
    .select(`
      *,
      from_user:users!from_user_id(
        id,
        name,
        avatar_url,
        role,
        is_verified,
        bio
      ),
      to_user:users!to_user_id(
        id,
        name,
        avatar_url,
        role,
        is_verified,
        bio
      ),
      post:posts!post_id(
        id,
        content,
        media_urls,
        author:users!author_id(
          id,
          name,
          avatar_url
        )
      ),
      comment:comments!comment_id(
        id,
        content,
        author:users!author_id(
          id,
          name,
          avatar_url
        )
      )
    `)
    .eq('id', id)
    .or(`from_user_id.eq.${req.user!.id},to_user_id.eq.${req.user!.id}`)
    .single();

  if (error || !transaction) {
    res.status(404).json({
      success: false,
      error: 'Transaction not found'
    });
    return;
  }

  res.json({
    success: true,
    transaction
  });
}));

// Transfer tokens to another user
router.post('/transfer', authenticateToken, validate(transferTokensSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { recipientId, amount, message } = req.body;

  // Check if recipient exists
  const { data: recipient, error: recipientError } = await supabase
    .from('users')
    .select('id, name, tokens')
    .eq('id', recipientId)
    .single();

  if (recipientError || !recipient) {
    res.status(404).json({
      success: false,
      error: 'Recipient not found'
    });
    return;
  }

  // Check if user is trying to transfer to themselves
  if (recipientId === req.user!.id) {
    res.status(400).json({
      success: false,
      error: 'Cannot transfer tokens to yourself'
    });
    return;
  }

  // Check sender's balance
  const { data: sender, error: senderError } = await supabase
    .from('users')
    .select('tokens')
    .eq('id', req.user!.id)
    .single();

  if (senderError || !sender) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch sender balance'
    });
    return;
  }

  if (sender.tokens < amount) {
    res.status(400).json({
      success: false,
      error: 'Insufficient token balance'
    });
    return;
  }

  const transactionId = uuidv4();
  const now = new Date().toISOString();

  try {
    // Start transaction
    const { error: deductError } = await supabase
      .from('users')
      .update({ tokens: sender.tokens - amount })
      .eq('id', req.user!.id);

    if (deductError) {
      throw new Error('Failed to deduct tokens from sender');
    }

    const { error: addError } = await supabase
      .from('users')
      .update({ tokens: recipient.tokens + amount })
      .eq('id', recipientId);

    if (addError) {
      // Rollback sender deduction
      await supabase
        .from('users')
        .update({ tokens: sender.tokens })
        .eq('id', req.user!.id);
      
      throw new Error('Failed to add tokens to recipient');
    }

    // Record transaction
    const { data: transaction, error: transactionError } = await supabase
      .from('token_transactions')
      .insert({
        id: transactionId,
        from_user_id: req.user!.id,
        to_user_id: recipientId,
        amount,
        type: 'transfer',
        description: message || `Token transfer from ${req.user!.name} to ${recipient.name}`,
        created_at: now
      })
      .select(`
        *,
        from_user:users!from_user_id(
          id,
          name,
          avatar_url
        ),
        to_user:users!to_user_id(
          id,
          name,
          avatar_url
        )
      `)
      .single();

    if (transactionError) {
      // Rollback both user updates
      await supabase
        .from('users')
        .update({ tokens: sender.tokens })
        .eq('id', req.user!.id);
      
      await supabase
        .from('users')
        .update({ tokens: recipient.tokens })
        .eq('id', recipientId);
      
      throw new Error('Failed to record transaction');
    }

    // Create notification for recipient
    const { data: notif } = await supabase
      .from('notifications')
      .insert({
        user_id: recipientId,
        type: 'system',
        title: 'Tokens Received',
        message: `You received ${amount} tokens from ${req.user!.name}${message ? `: ${message}` : ''}`,
        data: { transactionId, amount, senderId: req.user!.id },
        from_user_id: req.user!.id,
        created_at: now
      })
      .select()
      .single();

    const socketHandlers = (req as any).app?.locals?.socketHandlers;
    if (socketHandlers && notif) {
      socketHandlers.sendNotificationToUser(recipientId, notif);
    }

    res.json({
      success: true,
      message: 'Tokens transferred successfully',
      transaction
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      error: error.message || 'Token transfer failed'
    });
    return;
  }
}));

// Get token statistics
router.get('/stats', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const authed = createAuthedClient(req);

  // Source of truth: user_tokens
  let { data: ut, error: utErr } = await authed
    .from('user_tokens')
    .select('balance, total_earned, total_spent')
    .eq('user_id', userId)
    .single();

  // Lazy initialize if missing
  if ((utErr && utErr.code === 'PGRST116') || !ut) {
    await authed
      .from('user_tokens')
      .insert({ user_id: userId, balance: 100, total_earned: 100, total_spent: 0 })
      .single();
    await authed
      .from('users')
      .update({ tokens: 100 })
      .eq('id', userId);
    const reread = await authed
      .from('user_tokens')
      .select('balance, total_earned, total_spent')
      .eq('user_id', userId)
      .single();
    ut = reread.data as any;
  }

  // Recent activity (optional overview; safe to compute even if some transactions missing)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const { data: recentTransactions } = await authed
    .from('token_transactions')
    .select('amount, type, created_at, from_user_id, to_user_id')
    .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
    .gte('created_at', thirtyDaysAgo.toISOString());

  type Txn = { amount: number; type: string; to_user_id?: string; from_user_id?: string };
  const earnedList = (recentTransactions as Txn[] | undefined)?.filter((t: Txn) => t.to_user_id === userId && t.type !== 'transfer') || [];
  const spentList = (recentTransactions as Txn[] | undefined)?.filter((t: Txn) => t.from_user_id === userId && t.type !== 'transfer') || [];
  const recentEarned = earnedList.reduce((sum: number, t: Txn) => sum + (t.amount || 0), 0);
  const recentSpent = spentList.reduce((sum: number, t: Txn) => sum + (t.amount || 0), 0);

  res.json({
    success: true,
    stats: {
      currentBalance: ut?.balance || 0,
      totalEarned: ut?.total_earned || 0,
      totalSpent: ut?.total_spent || 0,
      netEarnings: (ut?.total_earned || 0) - (ut?.total_spent || 0),
      recentActivity: {
        earned: recentEarned,
        spent: recentSpent,
        net: recentEarned - recentSpent
      }
    }
  });
}));

// Get leaderboard (top token holders)
router.get('/leaderboard', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { limit = 10 } = req.query as any;

  const { data: topUsers, error } = await supabase
    .from('users')
    .select(`
      id,
      name,
      avatar_url,
      role,
      is_verified,
      tokens,
      location,
      sports_categories
    `)
    .order('tokens', { ascending: false })
    .limit(Math.min(limit, 50));

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch leaderboard'
    });
    return;
  }

  // Find current user's rank
  const { data: userRankData } = await supabase
    .from('users')
    .select('tokens')
    .gt('tokens', req.user!.tokens || 0);

  const userRank = (userRankData?.length || 0) + 1;

  res.json({
    success: true,
    leaderboard: topUsers || [],
    userRank,
    userTokens: req.user!.tokens || 0
  });
}));

// Get token earning opportunities
router.get('/opportunities', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const opportunities = [
    {
      type: 'post_creation',
      title: 'Create a Post',
      description: 'Share your sports journey and earn tokens',
      reward: '10-50 tokens',
      action: 'Create Post'
    },
    {
      type: 'daily_login',
      title: 'Daily Login',
      description: 'Login daily to earn bonus tokens',
      reward: '5 tokens',
      action: 'Login Daily'
    },
    {
      type: 'profile_completion',
      title: 'Complete Profile',
      description: 'Fill out your complete profile information',
      reward: '25 tokens',
      action: 'Complete Profile'
    },
    {
      type: 'first_post',
      title: 'First Post',
      description: 'Create your first post on the platform',
      reward: '50 tokens',
      action: 'Create First Post'
    },
    {
      type: 'engagement',
      title: 'Engage with Community',
      description: 'Like, comment, and share posts to earn tokens',
      reward: '1-5 tokens per action',
      action: 'Engage'
    },
    {
      type: 'referral',
      title: 'Refer Friends',
      description: 'Invite friends to join and earn bonus tokens',
      reward: '100 tokens per referral',
      action: 'Refer Friends'
    }
  ];

  // Check user's progress for some opportunities
  const { data: userPosts } = await supabase
    .from('posts')
    .select('id')
    .eq('author_id', req.user!.id)
    .limit(1);

  const hasCreatedPost = userPosts && userPosts.length > 0;

  // Filter out completed opportunities
  const availableOpportunities = opportunities.filter(opp => {
    if (opp.type === 'first_post' && hasCreatedPost) {
      return false;
    }
    return true;
  });

  res.json({
    success: true,
    opportunities: availableOpportunities
  });
}));

// Purchase tokens with payment
router.post('/purchase', authenticateToken, validate(purchaseTokensSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { packageId, paymentMethod, stripePaymentIntentId } = req.body;

  // Debug logging removed to reduce noise

  // Token packages configuration
  const tokenPackages = [
    { id: 'basic', tokens: 100, price: 4.99, bonus: 0 },
    { id: 'standard', tokens: 250, price: 9.99, bonus: 25 },
    { id: 'premium', tokens: 500, price: 19.99, bonus: 75 },
    { id: 'ultimate', tokens: 1000, price: 34.99, bonus: 200 }
  ];

  const selectedPackage = tokenPackages.find(pkg => pkg.id === packageId);
  if (!selectedPackage) {
    logger.warn('Token package not found', { packageId });
    res.status(400).json({
      success: false,
      error: 'Invalid package selected'
    });
    return;
  }

  const totalTokens = selectedPackage.tokens + selectedPackage.bonus;
  const userId = req.user!.id;

  try {
    // Debug logging removed to reduce noise
    
    // For demo purposes, we'll simulate successful payment
    // In production, you would integrate with Stripe or other payment processors
    if (paymentMethod === 'stripe' && !stripePaymentIntentId) {
      res.status(400).json({
        success: false,
        error: 'Stripe payment intent ID required for Stripe payments'
      });
      return;
    }

    // Simulate payment processing delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Create authenticated client for RLS
    const authed = createAuthedClient(req);

    // Get current user tokens
    const { data: userTokens, error: userTokensError } = await authed
      .from('user_tokens')
      .select('balance, total_earned')
      .eq('user_id', userId)
      .single();

    if (userTokensError && userTokensError.code !== 'PGRST116') {
      logger.error('Failed to fetch user tokens', { error: userTokensError, userId });
      throw new Error(`Failed to fetch user tokens: ${userTokensError.message}`);
    }

    const currentBalance = userTokens?.balance || 0;
    const currentTotalEarned = userTokens?.total_earned || 0;

    // Update user tokens
    const { error: updateTokensError } = await authed
      .from('user_tokens')
      .upsert({
        user_id: userId,
        balance: currentBalance + totalTokens,
        total_earned: currentTotalEarned + totalTokens,
        updated_at: new Date().toISOString()
      });

    if (updateTokensError) {
      logger.error('Failed to update user tokens', { error: updateTokensError, userId });
      throw new Error(`Failed to update user tokens: ${updateTokensError.message}`);
    }

    // Update users table tokens
    const { error: updateUsersError } = await authed
      .from('users')
      .update({ tokens: currentBalance + totalTokens })
      .eq('id', userId);

    if (updateUsersError) {
      logger.error('Failed to update users table', { error: updateUsersError, userId });
      throw new Error(`Failed to update user balance: ${updateUsersError.message}`);
    }

    // Record transaction
    const { data: transaction, error: transactionError } = await authed
      .from('token_transactions')
      .insert({
        to_user_id: userId,
        amount: totalTokens,
        type: 'earned',
        description: `Purchased ${selectedPackage.tokens} tokens${selectedPackage.bonus > 0 ? ` + ${selectedPackage.bonus} bonus` : ''} for $${selectedPackage.price}`,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (transactionError) {
      logger.error('Failed to record transaction', { error: transactionError, userId });
      throw new Error(`Failed to record transaction: ${transactionError.message}`);
    }

    // Create notification
    const { data: notif } = await authed
      .from('notifications')
      .insert({
        user_id: userId,
        type: 'system',
        title: 'Tokens Purchased',
        message: `You successfully purchased ${totalTokens} tokens!`,
        data: { 
          amount: totalTokens, 
          package: selectedPackage,
          transactionId: transaction.id 
        },
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
      message: 'Tokens purchased successfully',
      transaction,
      newBalance: currentBalance + totalTokens
    });

         } catch (error: any) {
           logger.error('Token purchase failed', { error: error.message, userId, packageId });
           res.status(400).json({
             success: false,
             error: error.message || 'Token purchase failed'
           });
         }
}));

// Award tokens (admin only)
router.post('/award', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  // Check if user is admin
  if (req.user!.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
    return;
  }

  const { userId, amount, reason } = req.body;

  if (!userId || !amount || amount <= 0) {
    res.status(400).json({
      success: false,
      error: 'Valid user ID and positive amount required'
    });
    return;
  }

  // Check if user exists
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, name, tokens')
    .eq('id', userId)
    .single();

  if (userError || !user) {
    res.status(404).json({
      success: false,
      error: 'User not found'
    });
    return;
  }

  // Update user's token balance
  const { error: updateError } = await supabase
    .from('users')
    .update({ tokens: user.tokens + amount })
    .eq('id', userId);

  if (updateError) {
    res.status(400).json({
      success: false,
      error: 'Failed to award tokens'
    });
    return;
  }

  // Record transaction
  const { data: transaction, error: transactionError } = await supabase
    .from('token_transactions')
    .insert({
      to_user_id: userId,
      amount,
      type: 'admin_award',
      description: reason || `Admin awarded ${amount} tokens`,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (transactionError) {
    res.status(400).json({
      success: false,
      error: 'Failed to record transaction'
    });
    return;
  }

  // Create notification
  const { data: notif2 } = await supabase
    .from('notifications')
    .insert({
      user_id: userId,
      type: 'system',
      title: 'Tokens Awarded',
      message: `You have been awarded ${amount} tokens${reason ? `: ${reason}` : ''}`,
      data: { amount, reason },
      from_user_id: req.user!.id,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  const socketHandlers2 = (req as any).app?.locals?.socketHandlers;
  if (socketHandlers2 && notif2) {
    socketHandlers2.sendNotificationToUser(userId, notif2);
  }

  res.json({
    success: true,
    message: 'Tokens awarded successfully',
    transaction
  });
}));

// Get referral code for user
router.get('/referral-code', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const referralCode = `SPORT${userId.slice(-4).toUpperCase()}`;
  
  res.json({
    success: true,
    referralCode,
    referralLink: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/signup?ref=${referralCode}`
  });
}));

// Process referral signup
router.post('/referral-signup', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { referralCode, newUserId } = req.body as any;

  if (!referralCode || !newUserId) {
    res.status(400).json({
      success: false,
      error: 'Referral code and user ID required'
    });
    return;
  }

  try {
    // Extract user ID from referral code
    const codeMatch = referralCode.match(/^SPORT(.+)$/);
    if (!codeMatch) {
      res.status(400).json({
        success: false,
        error: 'Invalid referral code format'
      });
      return;
    }

    const referrerId = codeMatch[1]?.toLowerCase() || '';
    const fullReferrerId = `00000000-0000-0000-0000-${referrerId.padStart(12, '0')}`;

    // Check if referrer exists
    const { data: referrer, error: referrerError } = await supabase
      .from('users')
      .select('id, name, tokens')
      .eq('id', fullReferrerId)
      .single();

    if (referrerError || !referrer) {
      res.status(404).json({
        success: false,
        error: 'Referrer not found'
      });
      return;
    }

    // Check if user has already been referred
    const { data: existingReferral } = await supabase
      .from('token_transactions')
      .select('id')
      .eq('to_user_id', newUserId)
      .eq('type', 'referral_signup')
      .single();

    if (existingReferral) {
      res.status(400).json({
        success: false,
        error: 'User has already been referred'
      });
      return;
    }

    const referralReward = 50;
    const newUserReward = 50;

    // Award tokens to referrer
    const { error: referrerUpdateError } = await supabase
      .from('users')
      .update({ tokens: referrer.tokens + referralReward })
      .eq('id', referrer.id);

    if (referrerUpdateError) {
      throw new Error('Failed to award referrer tokens');
    }

    // Update referrer's user_tokens
    const { error: referrerTokensError } = await supabase
      .from('user_tokens')
      .upsert({
        user_id: referrer.id,
        balance: referrer.tokens + referralReward,
        total_earned: referrer.tokens + referralReward,
        updated_at: new Date().toISOString()
      });

    if (referrerTokensError) {
      throw new Error('Failed to update referrer token stats');
    }

    // Award tokens to new user
    const { data: newUserTokens, error: newUserTokensError } = await supabase
      .from('user_tokens')
      .select('balance, total_earned')
      .eq('user_id', newUserId)
      .single();

    const currentBalance = newUserTokens?.balance || 0;
    const currentTotalEarned = newUserTokens?.total_earned || 0;

    const { error: newUserUpdateError } = await supabase
      .from('users')
      .update({ tokens: currentBalance + newUserReward })
      .eq('id', newUserId);

    if (newUserUpdateError) {
      throw new Error('Failed to award new user tokens');
    }

    const { error: newUserTokensUpdateError } = await supabase
      .from('user_tokens')
      .upsert({
        user_id: newUserId,
        balance: currentBalance + newUserReward,
        total_earned: currentTotalEarned + newUserReward,
        updated_at: new Date().toISOString()
      });

    if (newUserTokensUpdateError) {
      throw new Error('Failed to update new user token stats');
    }

    // Record transactions
    const { data: referrerTransaction, error: referrerTransactionError } = await supabase
      .from('token_transactions')
      .insert({
        to_user_id: referrer.id,
        amount: referralReward,
        type: 'referral',
        description: `Referral reward for ${newUserId}`,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (referrerTransactionError) {
      throw new Error('Failed to record referrer transaction');
    }

    const { data: newUserTransaction, error: newUserTransactionError } = await supabase
      .from('token_transactions')
      .insert({
        to_user_id: newUserId,
        amount: newUserReward,
        type: 'referral_signup',
        description: `Welcome bonus for signing up with referral code`,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (newUserTransactionError) {
      throw new Error('Failed to record new user transaction');
    }

    // Create notifications
    await supabase
      .from('notifications')
      .insert([
        {
          user_id: referrer.id,
          type: 'system',
          title: 'Referral Successful!',
          message: `You earned ${referralReward} tokens from a successful referral!`,
          data: { amount: referralReward, newUserId },
          created_at: new Date().toISOString()
        },
        {
          user_id: newUserId,
          type: 'system',
          title: 'Welcome Bonus!',
          message: `You received ${newUserReward} tokens for signing up with a referral code!`,
          data: { amount: newUserReward },
          created_at: new Date().toISOString()
        }
      ]);

    res.json({
      success: true,
      message: 'Referral processed successfully',
      referrerReward: referralReward,
      newUserReward: newUserReward
    });

  } catch (error: any) {
    res.status(400).json({
      success: false,
      error: error.message || 'Referral processing failed'
    });
  }
}));

// Get referral statistics
router.get('/referral-stats', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const { data: referrals, error } = await supabase
    .from('token_transactions')
    .select('amount, created_at')
    .eq('to_user_id', userId)
    .eq('type', 'referral');

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch referral stats'
    });
    return;
  }

  const totalReferrals = referrals?.length || 0;
  const totalEarned = referrals?.reduce((sum, ref) => sum + ref.amount, 0) || 0;

  res.json({
    success: true,
    stats: {
      totalReferrals,
      totalEarned,
      referrals: referrals || []
    }
  });
}));

export default router;