import express, { Request, Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { authenticateToken } from '../middleware/auth';
import { validate, validateParams } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import Joi from 'joi';

const router = express.Router();

// Validation schemas
const blockUserSchema = Joi.object({
  userId: Joi.string().uuid().required()
});

const reportUserSchema = Joi.object({
  userId: Joi.string().uuid().required(),
  reason: Joi.string().min(1).max(200).required(),
  description: Joi.string().max(1000).allow('', null)
});

// Block user
router.post('/block', authenticateToken, validate(blockUserSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.body;
  const blockerId = req.user!.id;

  // Prevent self-blocking
  if (userId === blockerId) {
    res.status(400).json({
      success: false,
      error: 'Cannot block yourself'
    });
    return;
  }

  // Check if user exists
  const { data: targetUser, error: userError } = await supabaseAdmin
    .from('users')
    .select('id, name')
    .eq('id', userId)
    .single();

  if (userError || !targetUser) {
    res.status(404).json({
      success: false,
      error: 'User not found'
    });
    return;
  }

  // Check if already blocked
  const { data: existingBlock } = await supabaseAdmin
    .from('user_blocks')
    .select('id')
    .eq('blocker_id', blockerId)
    .eq('blocked_id', userId)
    .single();

  if (existingBlock) {
    res.status(400).json({
      success: false,
      error: 'User is already blocked'
    });
    return;
  }

  // Create block record
  const { error: blockError } = await supabaseAdmin
    .from('user_blocks')
    .insert({
      blocker_id: blockerId,
      blocked_id: userId,
      created_at: new Date().toISOString()
    });

  if (blockError) {
    res.status(500).json({
      success: false,
      error: 'Failed to block user'
    });
    return;
  }

  // Remove any existing conversations between the users
  const { data: conversations } = await supabaseAdmin
    .from('conversations')
    .select(`
      id,
      participants:conversation_participants(
        user_id
      )
    `)
    .eq('type', 'direct');

  if (conversations) {
    for (const conversation of conversations) {
      const participantIds = conversation.participants.map((p: any) => p.user_id);
      if (participantIds.includes(blockerId) && participantIds.includes(userId)) {
        // Archive the conversation for the blocker
        await supabaseAdmin
          .from('conversation_participants')
          .update({ is_archived: true })
          .eq('conversation_id', conversation.id)
          .eq('user_id', blockerId);
      }
    }
  }

  res.json({
    success: true,
    message: 'User blocked successfully'
  });
}));

// Unblock user
router.post('/unblock', authenticateToken, validate(blockUserSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.body;
  const unblockerId = req.user!.id;

  // Check if block exists
  const { data: existingBlock } = await supabaseAdmin
    .from('user_blocks')
    .select('id')
    .eq('blocker_id', unblockerId)
    .eq('blocked_id', userId)
    .single();

  if (!existingBlock) {
    res.status(400).json({
      success: false,
      error: 'User is not blocked'
    });
    return;
  }

  // Remove block record
  const { error: unblockError } = await supabaseAdmin
    .from('user_blocks')
    .delete()
    .eq('blocker_id', unblockerId)
    .eq('blocked_id', userId);

  if (unblockError) {
    res.status(500).json({
      success: false,
      error: 'Failed to unblock user'
    });
    return;
  }

  res.json({
    success: true,
    message: 'User unblocked successfully'
  });
}));

// Report user
router.post('/report', authenticateToken, validate(reportUserSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { userId, reason, description } = req.body;
  const reporterId = req.user!.id;

  // Prevent self-reporting
  if (userId === reporterId) {
    res.status(400).json({
      success: false,
      error: 'Cannot report yourself'
    });
    return;
  }

  // Check if user exists
  const { data: targetUser, error: userError } = await supabaseAdmin
    .from('users')
    .select('id, name')
    .eq('id', userId)
    .single();

  if (userError || !targetUser) {
    res.status(404).json({
      success: false,
      error: 'User not found'
    });
    return;
  }

  // Check if already reported by this user
  const { data: existingReport } = await supabaseAdmin
    .from('user_reports')
    .select('id')
    .eq('reporter_id', reporterId)
    .eq('reported_id', userId)
    .single();

  if (existingReport) {
    res.status(400).json({
      success: false,
      error: 'User has already been reported by you'
    });
    return;
  }

  // Create report record
  const { error: reportError } = await supabaseAdmin
    .from('user_reports')
    .insert({
      reporter_id: reporterId,
      reported_id: userId,
      reason,
      description: description || null,
      status: 'pending',
      created_at: new Date().toISOString()
    });

  if (reportError) {
    res.status(500).json({
      success: false,
      error: 'Failed to report user'
    });
    return;
  }

  res.json({
    success: true,
    message: 'User reported successfully'
  });
}));

// Get blocked users
router.get('/blocked', authenticateToken, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const { data: blockedUsers, error } = await supabaseAdmin
    .from('user_blocks')
    .select(`
      id,
      created_at,
      blocked_user:users!blocked_id(
        id,
        name,
        avatar_url,
        role
      )
    `)
    .eq('blocker_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch blocked users'
    });
    return;
  }

  res.json({
    success: true,
    blocked_users: blockedUsers || []
  });
}));

// Check if user is blocked
router.get('/blocked/:userId', authenticateToken, validateParams(Joi.object({
  userId: Joi.string().uuid().required()
})), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;
  const currentUserId = req.user!.id;

  const { data: blockRecord } = await supabaseAdmin
    .from('user_blocks')
    .select('id')
    .eq('blocker_id', currentUserId)
    .eq('blocked_id', userId)
    .single();

  res.json({
    success: true,
    is_blocked: !!blockRecord
  });
}));

export default router;
