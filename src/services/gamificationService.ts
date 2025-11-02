import { supabaseAdmin } from '../config/supabase';
import { logger } from '../utils/logger';

/**
 * Gamification Service
 * Handles XP awards, achievement checking, quest progress, and streak updates
 */

export interface XPTransaction {
  userId: string;
  amount: number;
  sourceType: string;
  sourceId?: string;
  description?: string;
}

export interface AchievementCheck {
  userId: string;
  achievementType: string;
  currentValue: number;
}

/**
 * Award XP to a user and handle leveling up
 */
export async function awardXP(transaction: XPTransaction): Promise<{
  newLevel?: number;
  leveledUp?: boolean;
  xpToNext?: number;
} | null> {
  try {
    const { data, error } = await supabaseAdmin.rpc('add_user_xp', {
      user_id_param: transaction.userId,
      xp_amount: transaction.amount,
      source_type_param: transaction.sourceType,
      source_id_param: transaction.sourceId || null,
      description_param: transaction.description || `XP from ${transaction.sourceType}`
    });

    if (error) {
      logger.error('Failed to award XP', { error, transaction });
      return null;
    }

    return data?.[0] || {};
  } catch (error) {
    logger.error('Exception awarding XP', { error, transaction });
    return null;
  }
}

/**
 * Check and award achievements based on user progress
 */
export async function checkAchievements(check: AchievementCheck): Promise<void> {
  try {
    await supabaseAdmin.rpc('check_and_award_achievements', {
      user_id_param: check.userId,
      achievement_type_param: check.achievementType,
      current_value_param: check.currentValue
    });
  } catch (error) {
    logger.error('Failed to check achievements', { error, check });
  }
}

/**
 * Update quest progress for a user
 */
export async function updateQuestProgress(
  userId: string,
  questType: string,
  progressAmount: number = 1
): Promise<number> {
  try {
    const { data, error } = await supabaseAdmin.rpc('update_quest_progress', {
      user_id_param: userId,
      quest_type_param: questType,
      progress_amount: progressAmount
    });

    if (error) {
      logger.error('Failed to update quest progress', { error, userId, questType });
      return 0;
    }

    return data?.[0]?.completed_quests || 0;
  } catch (error) {
    logger.error('Exception updating quest progress', { error, userId, questType });
    return 0;
  }
}

/**
 * Update login streak for a user
 */
export async function updateLoginStreak(userId: string): Promise<number> {
  try {
    const { data, error } = await supabaseAdmin.rpc('update_login_streak', {
      user_id_param: userId
    });

    if (error) {
      logger.error('Failed to update login streak', { error, userId });
      return 0;
    }

    return data || 0;
  } catch (error) {
    logger.error('Exception updating login streak', { error, userId });
    return 0;
  }
}

/**
 * Get user stats for gamification (posts, likes, comments, follows count)
 */
export async function getUserGamificationStats(userId: string): Promise<{
  postsCreated: number;
  likesGiven: number;
  commentsCreated: number;
  followsGiven: number;
  loginStreak: number;
} | null> {
  try {
    const [postsResult, likesResult, commentsResult, followsResult, levelsResult] = await Promise.all([
      supabaseAdmin
        .from('posts')
        .select('id', { count: 'exact', head: true })
        .eq('author_id', userId),
      supabaseAdmin
        .from('post_likes')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId),
      supabaseAdmin
        .from('comments')
        .select('id', { count: 'exact', head: true })
        .eq('author_id', userId),
      supabaseAdmin
        .from('user_following')
        .select('id', { count: 'exact', head: true })
        .eq('follower_id', userId),
      supabaseAdmin
        .from('user_levels')
        .select('login_streak')
        .eq('user_id', userId)
        .single()
    ]);

    return {
      postsCreated: postsResult.count || 0,
      likesGiven: likesResult.count || 0,
      commentsCreated: commentsResult.count || 0,
      followsGiven: followsResult.count || 0,
      loginStreak: levelsResult.data?.login_streak || 0
    };
  } catch (error) {
    logger.error('Failed to get user gamification stats', { error, userId });
    return null;
  }
}

/**
 * Comprehensive function to handle post creation gamification
 */
export async function handlePostCreationGamification(userId: string, postId: string): Promise<void> {
  try {
    // Award XP for creating post
    await awardXP({
      userId,
      amount: 25,
      sourceType: 'post_created',
      sourceId: postId,
      description: 'Created a post'
    });

    // Update quest progress
    await updateQuestProgress(userId, 'posts_created', 1);

    // Get current post count and check achievements
    const stats = await getUserGamificationStats(userId);
    if (stats) {
      await checkAchievements({
        userId,
        achievementType: 'posts_created',
        currentValue: stats.postsCreated
      });
    }
  } catch (error) {
    logger.error('Failed to handle post creation gamification', { error, userId, postId });
  }
}

/**
 * Comprehensive function to handle like gamification
 */
export async function handleLikeGamification(userId: string, postId: string): Promise<void> {
  try {
    // Award XP for liking
    await awardXP({
      userId,
      amount: 5,
      sourceType: 'post_liked',
      sourceId: postId,
      description: 'Liked a post'
    });

    // Update quest progress
    await updateQuestProgress(userId, 'likes_given', 1);

    // Get current likes count and check achievements
    const stats = await getUserGamificationStats(userId);
    if (stats) {
      await checkAchievements({
        userId,
        achievementType: 'likes_given',
        currentValue: stats.likesGiven
      });
    }
  } catch (error) {
    logger.error('Failed to handle like gamification', { error, userId, postId });
  }
}

/**
 * Comprehensive function to handle comment creation gamification
 */
export async function handleCommentCreationGamification(userId: string, commentId: string): Promise<void> {
  try {
    // Award XP for commenting
    await awardXP({
      userId,
      amount: 10,
      sourceType: 'comment_created',
      sourceId: commentId,
      description: 'Created a comment'
    });

    // Update quest progress
    await updateQuestProgress(userId, 'comments_created', 1);

    // Get current comments count and check achievements
    const stats = await getUserGamificationStats(userId);
    if (stats) {
      await checkAchievements({
        userId,
        achievementType: 'comments_created',
        currentValue: stats.commentsCreated
      });
    }
  } catch (error) {
    logger.error('Failed to handle comment creation gamification', { error, userId, commentId });
  }
}

/**
 * Comprehensive function to handle follow gamification
 */
export async function handleFollowGamification(userId: string, followingId: string): Promise<void> {
  try {
    // Award XP for following
    await awardXP({
      userId,
      amount: 10,
      sourceType: 'user_followed',
      sourceId: followingId,
      description: 'Followed a user'
    });

    // Update quest progress
    await updateQuestProgress(userId, 'follows_given', 1);

    // Get current follows count and check achievements
    const stats = await getUserGamificationStats(userId);
    if (stats) {
      await checkAchievements({
        userId,
        achievementType: 'follows_given',
        currentValue: stats.followsGiven
      });
    }
  } catch (error) {
    logger.error('Failed to handle follow gamification', { error, userId, followingId });
  }
}

/**
 * Initialize daily quests for a user
 */
export async function initializeDailyQuests(userId: string): Promise<void> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Get all active daily quests
    const { data: dailyQuests, error: questsError } = await supabaseAdmin
      .from('quests')
      .select('*')
      .eq('quest_type', 'daily')
      .eq('is_active', true);

    if (questsError || !dailyQuests) {
      logger.error('Failed to fetch daily quests', { error: questsError });
      return;
    }

    // Check which quests user already has today
    const { data: existingQuests } = await supabaseAdmin
      .from('user_quests')
      .select('quest_id')
      .eq('user_id', userId)
      .gte('created_at', today.toISOString())
      .lt('created_at', tomorrow.toISOString());

    const existingQuestIds = new Set((existingQuests || []).map((q: any) => q.quest_id));

    // Create user quests for those not already active
    const questsToCreate = dailyQuests.filter((q: any) => !existingQuestIds.has(q.id));
    
    if (questsToCreate.length > 0) {
      const userQuests = questsToCreate.map((quest: any) => ({
        user_id: userId,
        quest_id: quest.id,
        progress: 0,
        target: quest.requirement_value,
        status: 'active',
        expires_at: tomorrow.toISOString()
      }));

      await supabaseAdmin
        .from('user_quests')
        .insert(userQuests);
    }
  } catch (error) {
    logger.error('Failed to initialize daily quests', { error, userId });
  }
}

