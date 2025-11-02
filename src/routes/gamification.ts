import express, { Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { validate, validateQuery, validateParams } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import Joi from 'joi';

const router = express.Router();

// Validation schemas
const getUserLevelSchema = Joi.object({
  userId: Joi.string().uuid().required()
});

const getLeaderboardQuerySchema = Joi.object({
  type: Joi.string().valid('xp', 'level', 'tokens', 'streak', 'achievements').default('xp'),
  limit: Joi.number().integer().min(1).max(100).default(10),
  category: Joi.string().optional()
});

// =====================================================
// USER LEVELS & XP
// =====================================================

// Helper function to create authenticated client
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

// Get user's level and XP
router.get('/levels/:userId', authenticateToken, validateParams(getUserLevelSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { userId } = req.params;

  // Check if requesting own level or if user exists
  if (req.user!.id !== userId) {
    // Allow viewing others' levels for leaderboards
  }

  const authed = createAuthedClient(req);

  let { data: userLevel, error } = await authed
    .from('user_levels')
    .select('*')
    .eq('user_id', userId)
    .single();

  // Initialize if doesn't exist
  if ((error && error.code === 'PGRST116') || !userLevel) {
    await authed.rpc('calculate_xp_for_level', { level: 1 });
    const xpToNext = 100;

    await authed
      .from('user_levels')
      .insert({
        user_id: userId,
        level: 1,
        current_xp: 0,
        total_xp: 0,
        xp_to_next_level: xpToNext,
        login_streak: 0,
        max_login_streak: 0,
        activity_streak: 0,
        max_activity_streak: 0
      });

    const { data: newLevel } = await authed
      .from('user_levels')
      .select('*')
      .eq('user_id', userId)
      .single();

    userLevel = newLevel as any;
  }

  // Calculate progress percentage
  const progress = userLevel?.xp_to_next_level > 0
    ? ((userLevel.current_xp / (userLevel.current_xp + userLevel.xp_to_next_level)) * 100)
    : 100;

  res.json({
    success: true,
    level: userLevel || {
      user_id: userId,
      level: 1,
      current_xp: 0,
      total_xp: 0,
      xp_to_next_level: 100,
      login_streak: 0,
      max_login_streak: 0,
      activity_streak: 0,
      max_activity_streak: 0
    },
    progress: Math.round(progress)
  });
}));

// Add XP to user (for testing/admin purposes)
router.post('/xp', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { userId, amount, sourceType = 'manual', description } = req.body;

  if (!userId || !amount || amount <= 0) {
    res.status(400).json({
      success: false,
      error: 'Valid userId and positive amount required'
    });
    return;
  }

  // Check if user is admin or adding to own account
  if (req.user!.id !== userId && req.user!.role !== 'admin' && req.user!.role !== 'administrator') {
    res.status(403).json({
      success: false,
      error: 'Not authorized'
    });
    return;
  }

  const authed = createAuthedClient(req);
  const { data, error } = await authed.rpc('add_user_xp', {
    user_id_param: userId,
    xp_amount: amount,
    source_type_param: sourceType,
    source_id_param: null,
    description_param: description || 'Manual XP award'
  });

  if (error) {
    logger.error('Failed to add XP', { error, userId, amount });
    res.status(400).json({
      success: false,
      error: 'Failed to add XP'
    });
    return;
  }

  res.json({
    success: true,
    message: 'XP added successfully',
    result: data?.[0] || {}
  });
}));

// Get XP transaction history
router.get('/xp/transactions', authenticateToken, validateQuery(Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20)
})), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { page = 1, limit = 20 } = req.query as any;
  const offset = (page - 1) * limit;

  const authed = createAuthedClient(req);
  const { data: transactions, error, count } = await authed
    .from('xp_transactions')
    .select('*', { count: 'exact' })
    .eq('user_id', req.user!.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch XP transactions'
    });
    return;
  }

  res.json({
    success: true,
    transactions: transactions || [],
    pagination: {
      currentPage: page,
      totalPages: Math.ceil((count || 0) / limit),
      totalTransactions: count,
      hasNextPage: page < Math.ceil((count || 0) / limit),
      hasPrevPage: page > 1
    }
  });
}));

// =====================================================
// ACHIEVEMENTS
// =====================================================

// Get all available achievements
router.get('/achievements', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const authed = createAuthedClient(req);

  const { data: achievements, error } = await authed
    .from('achievements')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch achievements'
    });
    return;
  }

  // Get user's unlocked achievements
  const { data: userAchievements } = await authed
    .from('user_achievements')
    .select('achievement_id, unlocked_at, is_new')
    .eq('user_id', req.user!.id);

  const unlockedSet = new Set((userAchievements || []).map((ua: any) => ua.achievement_id));
  const newSet = new Set(
    (userAchievements || [])
      .filter((ua: any) => ua.is_new)
      .map((ua: any) => ua.achievement_id)
  );

  const achievementsWithStatus = (achievements || []).map((ach: any) => ({
    ...ach,
    unlocked: unlockedSet.has(ach.id),
    is_new: newSet.has(ach.id),
    unlocked_at: userAchievements?.find((ua: any) => ua.achievement_id === ach.id)?.unlocked_at || null
  }));

  res.json({
    success: true,
    achievements: achievementsWithStatus
  });
}));

// Get user's achievements
router.get('/achievements/user/:userId', authenticateToken, validateParams(getUserLevelSchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { userId } = req.params;

  const authed = createAuthedClient(req);

  const { data: userAchievements, error } = await authed
    .from('user_achievements')
    .select(`
      *,
      achievement:achievements(*)
    `)
    .eq('user_id', userId)
    .order('unlocked_at', { ascending: false });

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch user achievements'
    });
    return;
  }

  // Count by rarity
  const rarityCounts = (userAchievements || []).reduce((acc: any, ua: any) => {
    const rarity = ua.achievement?.rarity || 'common';
    acc[rarity] = (acc[rarity] || 0) + 1;
    return acc;
  }, {});

  res.json({
    success: true,
    achievements: userAchievements || [],
    stats: {
      total: userAchievements?.length || 0,
      byRarity: rarityCounts,
      newCount: (userAchievements || []).filter((ua: any) => ua.is_new).length
    }
  });
}));

// Mark achievement as viewed (not new anymore)
router.post('/achievements/:achievementId/view', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { achievementId } = req.params;

  const authed = createAuthedClient(req);

  const { error } = await authed
    .from('user_achievements')
    .update({ is_new: false })
    .eq('user_id', req.user!.id)
    .eq('achievement_id', achievementId);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to update achievement status'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Achievement marked as viewed'
  });
}));

// =====================================================
// QUESTS
// =====================================================

// Get available quests
router.get('/quests', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { type = 'all' } = req.query as any;

  const authed = createAuthedClient(req);

  let query = authed
    .from('quests')
    .select('*')
    .eq('is_active', true);

  if (type !== 'all') {
    query = query.eq('quest_type', type);
  }

  query = query.order('sort_order', { ascending: true });

  const { data: quests, error } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch quests'
    });
    return;
  }

  // Get user's quest progress
  const { data: userQuests } = await authed
    .from('user_quests')
    .select('*')
    .eq('user_id', req.user!.id)
    .in('status', ['active', 'completed']);

  const questMap = new Map((userQuests || []).map((uq: any) => [uq.quest_id, uq]));

  const questsWithProgress = (quests || []).map((quest: any) => {
    const userQuest: any = questMap.get(quest.id);
    return {
      ...quest,
      userProgress: userQuest ? {
        progress: userQuest.progress || 0,
        target: userQuest.target || quest.requirement_value,
        status: userQuest.status || 'active',
        expires_at: userQuest.expires_at || null,
        completed_at: userQuest.completed_at || null
      } : null
    };
  });

  res.json({
    success: true,
    quests: questsWithProgress
  });
}));

// Get user's active quests
router.get('/quests/user', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const authed = createAuthedClient(req);

  const { data: userQuests, error } = await authed
    .from('user_quests')
    .select(`
      *,
      quest:quests(*)
    `)
    .eq('user_id', req.user!.id)
    .in('status', ['active', 'completed'])
    .order('created_at', { ascending: false });

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch user quests'
    });
    return;
  }

  // Separate active and completed
  const active = (userQuests || []).filter((uq: any) => uq.status === 'active');
  const completed = (userQuests || []).filter((uq: any) => uq.status === 'completed');

  res.json({
    success: true,
    active: active || [],
    completed: completed || [],
    stats: {
      activeCount: active.length,
      completedCount: completed.length
    }
  });
}));

// Claim quest reward
router.post('/quests/:questId/claim', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { questId } = req.params;

  const authed = createAuthedClient(req);

  // Check if quest is completed
  const { data: userQuest, error: fetchError } = await authed
    .from('user_quests')
    .select('*, quest:quests(*)')
    .eq('user_id', req.user!.id)
    .eq('quest_id', questId)
    .eq('status', 'completed')
    .single();

  if (fetchError || !userQuest) {
    res.status(400).json({
      success: false,
      error: 'Quest not found or not completed'
    });
    return;
  }

  // Mark as claimed
  const { error: updateError } = await authed
    .from('user_quests')
    .update({ status: 'claimed' })
    .eq('id', userQuest.id);

  if (updateError) {
    res.status(400).json({
      success: false,
      error: 'Failed to claim quest reward'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Quest reward claimed',
    xp_earned: userQuest.xp_earned || 0,
    tokens_earned: userQuest.tokens_earned || 0
  });
}));

// =====================================================
// LEADERBOARDS
// =====================================================

// Get leaderboard
router.get('/leaderboard', authenticateToken, validateQuery(getLeaderboardQuerySchema), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { type = 'xp', limit = 10 } = req.query as any;

  let query;
  let orderBy: { column: string; ascending: boolean };

  switch (type) {
    case 'xp':
      query = supabaseAdmin
        .from('user_levels')
        .select(`
          user_id,
          total_xp,
          level,
          users!user_id(
            id,
            name,
            username,
            avatar_url,
            is_verified,
            role
          )
        `)
        .not('user_id', 'is', null);
      orderBy = { column: 'total_xp', ascending: false };
      break;

    case 'level':
      query = supabaseAdmin
        .from('user_levels')
        .select(`
          user_id,
          level,
          total_xp,
          users!user_id(
            id,
            name,
            username,
            avatar_url,
            is_verified,
            role
          )
        `)
        .not('user_id', 'is', null);
      orderBy = { column: 'level', ascending: false };
      break;

    case 'tokens':
      query = supabaseAdmin
        .from('users')
        .select(`
          id,
          name,
          username,
          avatar_url,
          is_verified,
          role,
          tokens
        `)
        .not('tokens', 'is', null);
      orderBy = { column: 'tokens', ascending: false };
      break;

    case 'streak':
      query = supabaseAdmin
        .from('user_levels')
        .select(`
          user_id,
          login_streak,
          level,
          users!user_id(
            id,
            name,
            username,
            avatar_url,
            is_verified,
            role
          )
        `)
        .not('user_id', 'is', null);
      orderBy = { column: 'login_streak', ascending: false };
      break;

    case 'achievements':
      // Complex query - get users with most achievements
      query = supabaseAdmin
        .from('user_achievements')
        .select(`
          user_id,
          users!user_id(
            id,
            name,
            username,
            avatar_url,
            is_verified,
            role
          )
        `)
        .not('user_id', 'is', null);
      orderBy = { column: 'user_id', ascending: true }; // Will aggregate
      break;

    default:
      res.status(400).json({
        success: false,
        error: 'Invalid leaderboard type'
      });
      return;
  }

  let leaderboardData: any[] = [];
  let userRank = null;
  let userData = null;

  if (type === 'achievements') {
    // Special handling for achievements leaderboard
    const { data: achievementCounts, error: achError } = await supabaseAdmin
      .rpc('get_achievement_leaderboard', { limit_param: Number(limit) });

    if (!achError && achievementCounts) {
      leaderboardData = achievementCounts.map((entry: any, index: number) => ({
        rank: index + 1,
        ...entry
      }));

      // Find user's rank
      const userIndex = leaderboardData.findIndex((entry: any) => entry.user_id === req.user!.id);
      if (userIndex >= 0) {
        userRank = userIndex + 1;
        userData = leaderboardData[userIndex];
      }
    }
  } else {
    query = query.order(orderBy.column, { ascending: orderBy.ascending }).limit(Number(limit));
    const { data, error } = await query;

    if (error) {
      logger.error('Leaderboard query error', { error, type });
      res.status(400).json({
        success: false,
        error: 'Failed to fetch leaderboard'
      });
      return;
    }

    leaderboardData = (data || []).map((entry: any, index: number) => {
      const user = entry.users || entry;
      const value = type === 'tokens' ? entry.tokens : (entry[orderBy.column] || 0);

      return {
        rank: index + 1,
        user_id: user.id || entry.user_id,
        name: user.name,
        username: user.username,
        avatar_url: user.avatar_url,
        is_verified: user.is_verified,
        role: user.role,
        value: value,
        level: entry.level || null,
        total_xp: entry.total_xp || null
      };
    });

    // Get user's rank and data
    let userQuery;
    switch (type) {
      case 'xp':
      case 'level':
      case 'streak':
        const { data: userLevel } = await supabaseAdmin
          .from('user_levels')
          .select('*')
          .eq('user_id', req.user!.id)
          .single();

        if (userLevel) {
          const column = type === 'xp' ? 'total_xp' : (type === 'level' ? 'level' : 'login_streak');
          const { count } = await supabaseAdmin
            .from('user_levels')
            .select('*', { count: 'exact', head: true })
            .gt(column, userLevel[column]);

          userRank = (count || 0) + 1;
          userData = {
            rank: userRank,
            user_id: req.user!.id,
            value: userLevel[column],
            level: userLevel.level,
            total_xp: userLevel.total_xp
          };
        }
        break;

      case 'tokens':
        const { data: user } = await supabaseAdmin
          .from('users')
          .select('tokens')
          .eq('id', req.user!.id)
          .single();

        if (user) {
          const { count } = await supabaseAdmin
            .from('users')
            .select('*', { count: 'exact', head: true })
            .gt('tokens', user.tokens || 0);

          userRank = (count || 0) + 1;
          userData = {
            rank: userRank,
            user_id: req.user!.id,
            value: user.tokens || 0
          };
        }
        break;
    }
  }

  res.json({
    success: true,
    leaderboard: leaderboardData,
    userRank,
    userData,
    type
  });
}));

export default router;

