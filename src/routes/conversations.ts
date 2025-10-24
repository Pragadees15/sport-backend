import express, { Request, Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { authenticateToken } from '../middleware/auth';
import { validate, validateQuery, validateParams } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Validation schemas
const createConversationSchema = Joi.object({
  type: Joi.string().valid('direct', 'group').required(),
  name: Joi.string().when('type', {
    is: 'group',
    then: Joi.string().required().max(100),
    otherwise: Joi.optional()
  }),
  description: Joi.string().max(500).allow(''),
  participantIds: Joi.array().items(Joi.string().uuid()).min(1).required(),
  isPrivate: Joi.boolean().default(false)
});

const updateConversationSchema = Joi.object({
  name: Joi.string().max(100),
  description: Joi.string().max(500).allow(''),
  isPrivate: Joi.boolean(),
  photo_url: Joi.string().uri().allow('')
});

const addParticipantsSchema = Joi.object({
  participantIds: Joi.array().items(Joi.string().uuid()).min(1).required()
});

const removeParticipantSchema = Joi.object({
  id: Joi.string().uuid().required(),
  participantId: Joi.string().uuid().required()
});

const getConversationsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  type: Joi.string().valid('direct', 'group', 'all').default('all'),
  search: Joi.string().min(1).max(100)
});

const conversationIdSchema = Joi.object({
  id: Joi.string().uuid().required()
});

// Get user's conversations
router.get('/', authenticateToken, validateQuery(getConversationsQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 20,
    type = 'all',
    search
  } = req.query as any;

  const offset = (page - 1) * limit;

  // First get conversations where user is a participant and not archived
  const { data: userConversations } = await supabaseAdmin
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', req.user!.id)
    .eq('is_archived', false);

  if (!userConversations || userConversations.length === 0) {
    res.json({
      success: true,
      conversations: [],
      pagination: {
        page,
        limit,
        total: 0,
        totalPages: 0
      }
    });
    return;
  }

  const conversationIds = userConversations.map(uc => uc.conversation_id);

  // Get blocked users to filter them out
  const { data: blockedUsers } = await supabaseAdmin
    .from('user_blocks')
    .select('blocked_id')
    .eq('blocker_id', req.user!.id);

  const blockedUserIds = blockedUsers?.map(bu => bu.blocked_id) || [];

  let query = supabaseAdmin
    .from('conversations')
    .select(`
      *,
      participants:conversation_participants(
        user:users!user_id(
          id,
          name,
          avatar_url,
          role,
          is_verified
        )
      )
    `, { count: 'exact' })
    .in('id', conversationIds)
    .range(offset, offset + limit - 1)
    .order('last_message_at', { ascending: false });

  // Filter by conversation type
  if (type !== 'all') {
    query = query.eq('type', type);
  }

  // Search by conversation name
  if (search) {
    query = query.ilike('name', `%${search}%`);
  }

  const { data: conversations, error, count } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch conversations'
    });
    return;
  }

  // Filter out conversations with blocked users
  const filteredConversations = (conversations || []).filter(conversation => {
    if (conversation.type === 'direct') {
      // For direct conversations, check if the other participant is blocked
      const otherParticipant = conversation.participants?.find((p: any) => p.user.id !== req.user!.id);
      return !otherParticipant || !blockedUserIds.includes(otherParticipant.user.id);
    }
    // For group conversations, check if any participant is blocked
    return !conversation.participants?.some((p: any) => blockedUserIds.includes(p.user.id));
  });

  // Calculate unread counts and get last message for each conversation
  const conversationsWithUnread = await Promise.all(
    filteredConversations.map(async (conversation) => {
      // Get unread count
      const { count: unreadCount } = await supabaseAdmin
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('conversation_id', conversation.id)
        .not('sender_id', 'eq', req.user!.id)
        .not('id', 'in', 
          supabaseAdmin
            .from('message_reads')
            .select('message_id')
            .eq('user_id', req.user!.id)
        );

      // Get last message
      const { data: lastMessage } = await supabaseAdmin
        .from('messages')
        .select(`
          content,
          created_at,
          sender:users!sender_id(
            name
          )
        `)
        .eq('conversation_id', conversation.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      return {
        ...conversation,
        unread_count: unreadCount || 0,
        last_message: lastMessage
      };
    })
  );

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    conversations: conversationsWithUnread,
    pagination: {
      currentPage: page,
      totalPages,
      totalConversations: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get single conversation
router.get('/:id', authenticateToken, validateParams(conversationIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  // Check if user is participant
  const { data: participant } = await supabaseAdmin
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', id)
    .eq('user_id', req.user!.id)
    .single();

  if (!participant) {
    res.status(403).json({
      success: false,
      error: 'Not authorized to view this conversation'
    });
    return;
  }

  const { data: conversation, error } = await supabaseAdmin
    .from('conversations')
    .select(`
      *,
      participants:conversation_participants(
        user:users!user_id(
          id,
          name,
          avatar_url,
          role,
          is_verified,
          bio,
          location
        ),
        joined_at,
        role
      ),
      created_by:users!created_by(
        id,
        name,
        avatar_url
      )
    `)
    .eq('id', id)
    .single();

  if (error || !conversation) {
    res.status(404).json({
      success: false,
      error: 'Conversation not found'
    });
    return;
  }

  // Get unread count
  const { count: unreadCount } = await supabaseAdmin
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', id)
    .not('sender_id', 'eq', req.user!.id)
    .not('id', 'in', 
      supabaseAdmin
        .from('message_reads')
        .select('message_id')
        .eq('user_id', req.user!.id)
    );

  res.json({
    success: true,
    conversation: {
      ...conversation,
      unread_count: unreadCount || 0
    }
  });
}));

// Create new conversation
router.post('/', authenticateToken, validate(createConversationSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  console.log('=== CREATE CONVERSATION DEBUG ===');
  console.log('Request body:', req.body);
  console.log('User ID:', req.user?.id);
  
  const {
    type,
    name,
    description,
    participantIds,
    isPrivate
  } = req.body;

  console.log('Parsed data:', { type, name, description, participantIds, isPrivate });

  // Validate participants exist
  console.log('Validating participants:', participantIds);
  const { data: users, error: usersError } = await supabaseAdmin
    .from('users')
    .select('id')
    .in('id', participantIds);

  console.log('Users query result:', { users, usersError });

  if (usersError || !users || users.length !== participantIds.length) {
    console.log('Participants validation failed');
    res.status(400).json({
      success: false,
      error: 'Some participants not found'
    });
    return;
  }

  // For direct conversations, check if one already exists
  if (type === 'direct' && participantIds.length === 1) {
    console.log('Checking for existing direct conversation');
    const otherUserId = participantIds[0];
    console.log('Other user ID:', otherUserId);
    console.log('Current user ID:', req.user!.id);
    
    // Check if direct conversation already exists between these two users
    const { data: existingConversations, error: existingError } = await supabaseAdmin
      .from('conversations')
      .select(`
        id,
        participants:conversation_participants(
          user_id
        )
      `)
      .eq('type', 'direct');

    console.log('Existing conversations query:', { existingConversations, existingError });

    // Filter conversations that have exactly these two participants
    const existingConversation = existingConversations?.find(conv => {
      const participantIds = conv.participants.map(p => p.user_id);
      return participantIds.length === 2 && 
             participantIds.includes(req.user!.id) && 
             participantIds.includes(otherUserId);
    });

    console.log('Found existing conversation:', existingConversation);

    if (existingConversation) {
      console.log('Returning existing conversation');
      res.status(400).json({
        success: false,
        error: 'Direct conversation already exists',
        conversationId: existingConversation.id
      });
      return;
    }
  }

  console.log('Creating new conversation');
  const conversationId = uuidv4();
  const now = new Date().toISOString();
  console.log('Generated conversation ID:', conversationId);

  // Create conversation
  const conversationData = {
    id: conversationId,
    type,
    name: type === 'direct' ? null : name,
    description,
    is_private: isPrivate,
    created_by: req.user!.id,
    created_at: now,
    last_message_at: now
  };
  console.log('Conversation data to insert:', conversationData);
  
  const { data: conversation, error: conversationError } = await supabaseAdmin
    .from('conversations')
    .insert(conversationData)
    .select()
    .single();

  console.log('Conversation creation result:', { conversation, conversationError });

  if (conversationError) {
    console.log('Failed to create conversation:', conversationError);
    res.status(400).json({
      success: false,
      error: 'Failed to create conversation'
    });
    return;
  }

  // Add participants (including creator)
  const allParticipantIds = [...new Set([req.user!.id, ...participantIds])];
  const participants = allParticipantIds.map(userId => ({
    conversation_id: conversationId,
    user_id: userId,
    role: userId === req.user!.id ? 'admin' : 'member',
    joined_at: now
  }));

  const { error: participantsError } = await supabaseAdmin
    .from('conversation_participants')
    .insert(participants);

  if (participantsError) {
    // Rollback conversation creation
    await supabaseAdmin
      .from('conversations')
      .delete()
      .eq('id', conversationId);

    res.status(400).json({
      success: false,
      error: 'Failed to add participants'
    });
    return;
  }

  // Get full conversation data
  const { data: fullConversation } = await supabaseAdmin
    .from('conversations')
    .select(`
      *,
      participants:conversation_participants(
        user:users!user_id(
          id,
          name,
          avatar_url,
          role,
          is_verified
        ),
        joined_at,
        role
      )
    `)
    .eq('id', conversationId)
    .single();

  res.status(201).json({
    success: true,
    message: 'Conversation created successfully',
    conversation: fullConversation
  });
}));

// Update conversation
router.put('/:id', authenticateToken, validateParams(conversationIdSchema), validate(updateConversationSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { name, description, isPrivate, photo_url } = req.body;

  // Check if user is admin of the conversation
  const { data: participant } = await supabaseAdmin
    .from('conversation_participants')
    .select('role')
    .eq('conversation_id', id)
    .eq('user_id', req.user!.id)
    .single();

  if (!participant || participant.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'Not authorized to update this conversation'
    });
    return;
  }

  const updateData: any = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (isPrivate !== undefined) updateData.is_private = isPrivate;
  if (photo_url !== undefined) updateData.photo_url = photo_url;

  const { data: updatedConversation, error } = await supabaseAdmin
    .from('conversations')
    .update(updateData)
    .eq('id', id)
    .select(`
      *,
      participants:conversation_participants(
        user:users!user_id(
          id,
          name,
          avatar_url,
          role,
          is_verified
        ),
        joined_at,
        role
      )
    `)
    .single();

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to update conversation'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Conversation updated successfully',
    conversation: updatedConversation
  });
}));

// Delete conversation
router.delete('/:id', authenticateToken, validateParams(conversationIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  // Check if user is admin of the conversation
  const { data: participant } = await supabaseAdmin
    .from('conversation_participants')
    .select('role')
    .eq('conversation_id', id)
    .eq('user_id', req.user!.id)
    .single();

  if (!participant || participant.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'Not authorized to delete this conversation'
    });
    return;
  }

  // Delete conversation (cascade will handle participants and messages)
  const { error } = await supabaseAdmin
    .from('conversations')
    .delete()
    .eq('id', id);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to delete conversation'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Conversation deleted successfully'
  });
}));

// Add participants to conversation
router.post('/:id/participants', authenticateToken, validateParams(conversationIdSchema), validate(addParticipantsSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { participantIds } = req.body;

  // Check if user is admin of the conversation
  const { data: participant } = await supabaseAdmin
    .from('conversation_participants')
    .select('role')
    .eq('conversation_id', id)
    .eq('user_id', req.user!.id)
    .single();

  if (!participant || participant.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'Not authorized to add participants'
    });
    return;
  }

  // Check if conversation is group type
  const { data: conversation } = await supabaseAdmin
    .from('conversations')
    .select('type')
    .eq('id', id)
    .single();

  if (!conversation || conversation.type !== 'group') {
    res.status(400).json({
      success: false,
      error: 'Can only add participants to group conversations'
    });
    return;
  }

  // Validate participants exist
  const { data: users, error: usersError } = await supabaseAdmin
    .from('users')
    .select('id')
    .in('id', participantIds);

  if (usersError || !users || users.length !== participantIds.length) {
    res.status(400).json({
      success: false,
      error: 'Some participants not found'
    });
    return;
  }

  // Check which users are not already participants
  const { data: existingParticipants } = await supabaseAdmin
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', id)
    .in('user_id', participantIds);

  const existingUserIds = existingParticipants?.map(p => p.user_id) || [];
  const newParticipantIds = participantIds.filter((id: string) => !existingUserIds.includes(id));

  if (newParticipantIds.length === 0) {
    res.status(400).json({
      success: false,
      error: 'All users are already participants'
    });
    return;
  }

  // Add new participants
  const newParticipants = newParticipantIds.map((userId: string) => ({
    conversation_id: id,
    user_id: userId,
    role: 'member',
    joined_at: new Date().toISOString()
  }));

  const { error: addError } = await supabaseAdmin
    .from('conversation_participants')
    .insert(newParticipants);

  if (addError) {
    res.status(400).json({
      success: false,
      error: 'Failed to add participants'
    });
    return;
  }

  // Create system message about added participants
  const { data: addedUsers } = await supabaseAdmin
    .from('users')
    .select('name')
    .in('id', newParticipantIds);

  const userNames = addedUsers?.map(u => u.name).join(', ') || 'users';
  
  // Get current user's name
  const { data: currentUser } = await supabaseAdmin
    .from('users')
    .select('name')
    .eq('id', req.user!.id)
    .single();
  
  const currentUserName = currentUser?.name || req.user!.email;
  
  await supabaseAdmin
    .from('messages')
    .insert({
      conversation_id: id,
      sender_id: req.user!.id,
      content: `${currentUserName} added ${userNames} to the conversation`,
      type: 'system',
      created_at: new Date().toISOString()
    });

  res.json({
    success: true,
    message: 'Participants added successfully',
    addedCount: newParticipantIds.length
  });
}));

// Remove participant from conversation
router.delete('/:id/participants/:participantId', authenticateToken, validateParams(removeParticipantSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id, participantId } = req.params;

  // Check if user is admin of the conversation or removing themselves
  const { data: userParticipant } = await supabaseAdmin
    .from('conversation_participants')
    .select('role')
    .eq('conversation_id', id)
    .eq('user_id', req.user!.id)
    .single();

  const isAdmin = userParticipant?.role === 'admin';
  const isRemovingSelf = participantId === req.user!.id;

  if (!isAdmin && !isRemovingSelf) {
    res.status(403).json({
      success: false,
      error: 'Not authorized to remove this participant'
    });
    return;
  }

  // Check if participant exists in conversation
  const { data: targetParticipant } = await supabaseAdmin
    .from('conversation_participants')
    .select('*')
    .eq('conversation_id', id)
    .eq('user_id', participantId)
    .single();

  if (!targetParticipant) {
    res.status(404).json({
      success: false,
      error: 'Participant not found in conversation'
    });
    return;
  }

  // Remove participant
  const { error } = await supabaseAdmin
    .from('conversation_participants')
    .delete()
    .eq('conversation_id', id)
    .eq('user_id', participantId);

  if (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to remove participant'
    });
    return;
  }

  // Get user names for the system message
  const { data: userData } = await supabaseAdmin
    .from('users')
    .select('name')
    .eq('id', req.user!.id)
    .single();

  const { data: targetUserData } = await supabaseAdmin
    .from('users')
    .select('name')
    .eq('id', participantId)
    .single();

  // Create system message
  const action = isRemovingSelf ? 'left' : 'was removed from';
  const actor = isRemovingSelf ? (targetUserData?.name || 'User') : (userData?.name || req.user!.email);
  
  await supabaseAdmin
    .from('messages')
    .insert({
      conversation_id: id,
      sender_id: req.user!.id,
      content: `${actor} ${action} the conversation`,
      type: 'system',
      created_at: new Date().toISOString()
    });

  res.json({
    success: true,
    message: 'Participant removed successfully'
  });
}));

// Get conversation participants
router.get('/:id/participants', authenticateToken, validateParams(conversationIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  // Check if user is participant
  const { data: participant } = await supabaseAdmin
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', id)
    .eq('user_id', req.user!.id)
    .single();

  if (!participant) {
    res.status(403).json({
      success: false,
      error: 'Not authorized to view participants'
    });
    return;
  }

  const { data: participants, error } = await supabaseAdmin
    .from('conversation_participants')
    .select(`
      *,
      user:users!user_id(
        id,
        name,
        avatar_url,
        role,
        is_verified,
        bio,
        location
      )
    `)
    .eq('conversation_id', id)
    .order('joined_at', { ascending: true });

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch participants'
    });
    return;
  }

  res.json({
    success: true,
    participants: participants || []
  });
}));

// Leave conversation
router.post('/:id/leave', authenticateToken, validateParams(conversationIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  // Check if user is participant
  const { data: participant } = await supabaseAdmin
    .from('conversation_participants')
    .select('role')
    .eq('conversation_id', id)
    .eq('user_id', req.user!.id)
    .single();

  if (!participant) {
    res.status(404).json({
      success: false,
      error: 'Not a participant in this conversation'
    });
    return;
  }

  // Check if this is a direct conversation
  const { data: conversation } = await supabaseAdmin
    .from('conversations')
    .select('type')
    .eq('id', id)
    .single();

  if (conversation?.type === 'direct') {
    res.status(400).json({
      success: false,
      error: 'Cannot leave direct conversations'
    });
    return;
  }

  // Remove participant
  const { error } = await supabaseAdmin
    .from('conversation_participants')
    .delete()
    .eq('conversation_id', id)
    .eq('user_id', req.user!.id);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to leave conversation'
    });
    return;
  }

  // Get user's name for the system message
  const { data: userData } = await supabaseAdmin
    .from('users')
    .select('name')
    .eq('id', req.user!.id)
    .single();

  // Create system message
  await supabaseAdmin
    .from('messages')
    .insert({
      conversation_id: id,
      sender_id: req.user!.id,
      content: `${userData?.name || req.user!.email} left the conversation`,
      type: 'system',
      created_at: new Date().toISOString()
    });

  res.json({
    success: true,
    message: 'Left conversation successfully'
  });
}));

// Mark all messages in conversation as read
router.patch('/:id/read', authenticateToken, validateParams(conversationIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  // Check if user is participant
  const { data: participant } = await supabaseAdmin
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', id)
    .eq('user_id', req.user!.id)
    .single();

  if (!participant) {
    res.status(403).json({
      success: false,
      error: 'Not authorized to access this conversation'
    });
    return;
  }

  // Get all unread messages in this conversation for this user
  const { data: unreadMessages } = await supabaseAdmin
    .from('messages')
    .select('id')
    .eq('conversation_id', id)
    .neq('sender_id', req.user!.id)
    .not('id', 'in', 
      supabaseAdmin
        .from('message_reads')
        .select('message_id')
        .eq('user_id', req.user!.id)
    );

  if (unreadMessages && unreadMessages.length > 0) {
    const messageIds = unreadMessages.map(m => m.id);
    
    // Mark messages as read
    const { error: readError } = await supabaseAdmin
      .from('message_reads')
      .upsert(
        messageIds.map(messageId => ({
          message_id: messageId,
          user_id: req.user!.id,
          read_at: new Date().toISOString()
        })),
        { onConflict: 'message_id,user_id' }
      );

    if (readError) {
      res.status(400).json({
        success: false,
        error: 'Failed to mark messages as read'
      });
      return;
    }
  }

  res.json({
    success: true,
    message: 'Messages marked as read'
  });
}));

// Clear conversation messages
router.delete('/:id/clear', authenticateToken, validateParams(conversationIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const userId = req.user!.id;

  // Check if user is participant
  const { data: participant } = await supabaseAdmin
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', id)
    .eq('user_id', userId)
    .single();

  if (!participant) {
    res.status(403).json({
      success: false,
      error: 'Not authorized to clear this conversation'
    });
    return;
  }

  // Soft delete all messages in the conversation for this user
  const { error: deleteError } = await supabaseAdmin
    .from('messages')
    .update({
      is_deleted: true,
      deleted_at: new Date().toISOString(),
      content: 'This message was deleted'
    })
    .eq('conversation_id', id)
    .neq('sender_id', userId); // Don't delete messages sent by the user

  if (deleteError) {
    res.status(500).json({
      success: false,
      error: 'Failed to clear conversation'
    });
    return;
  }

  // Create a system message indicating the conversation was cleared
  await supabaseAdmin
    .from('messages')
    .insert({
      conversation_id: id,
      sender_id: userId,
      content: 'Cleared conversation history',
      type: 'system',
      created_at: new Date().toISOString()
    });

  res.json({
    success: true,
    message: 'Conversation cleared successfully'
  });
}));

// Archive conversation
router.post('/:id/archive', authenticateToken, validateParams(conversationIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const userId = req.user!.id;

  // Check if user is participant
  const { data: participant } = await supabaseAdmin
    .from('conversation_participants')
    .select('user_id, is_archived')
    .eq('conversation_id', id)
    .eq('user_id', userId)
    .single();

  if (!participant) {
    res.status(403).json({
      success: false,
      error: 'Not authorized to archive this conversation'
    });
    return;
  }

  if (participant.is_archived) {
    res.status(400).json({
      success: false,
      error: 'Conversation is already archived'
    });
    return;
  }

  // Archive the conversation for this user
  const { error: archiveError } = await supabaseAdmin
    .from('conversation_participants')
    .update({
      is_archived: true,
      archived_at: new Date().toISOString()
    })
    .eq('conversation_id', id)
    .eq('user_id', userId);

  if (archiveError) {
    res.status(500).json({
      success: false,
      error: 'Failed to archive conversation'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Conversation archived successfully'
  });
}));

// Unarchive conversation
router.post('/:id/unarchive', authenticateToken, validateParams(conversationIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const userId = req.user!.id;

  // Check if user is participant
  const { data: participant } = await supabaseAdmin
    .from('conversation_participants')
    .select('user_id, is_archived')
    .eq('conversation_id', id)
    .eq('user_id', userId)
    .single();

  if (!participant) {
    res.status(403).json({
      success: false,
      error: 'Not authorized to unarchive this conversation'
    });
    return;
  }

  if (!participant.is_archived) {
    res.status(400).json({
      success: false,
      error: 'Conversation is not archived'
    });
    return;
  }

  // Unarchive the conversation for this user
  const { error: unarchiveError } = await supabaseAdmin
    .from('conversation_participants')
    .update({
      is_archived: false,
      archived_at: null
    })
    .eq('conversation_id', id)
    .eq('user_id', userId);

  if (unarchiveError) {
    res.status(500).json({
      success: false,
      error: 'Failed to unarchive conversation'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Conversation unarchived successfully'
  });
}));

export default router;