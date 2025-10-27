import express, { Request, Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { authenticateToken, optionalAuthMiddleware } from '../middleware/auth';
import { validate, validateQuery, validateParams } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import { moderateContent } from '../middleware/contentModeration';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Validation schemas
const createCommentSchema = Joi.object({
  postId: Joi.string().uuid().required(),
  content: Joi.string().required().max(1000),
  parentId: Joi.string().uuid().allow(null)
});

const updateCommentSchema = Joi.object({
  content: Joi.string().required().max(1000)
});

const getCommentsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  sortBy: Joi.string().valid('created_at', 'likes').default('created_at'),
  sortOrder: Joi.string().valid('asc', 'desc').default('asc')
});

const commentIdSchema = Joi.object({
  id: Joi.string().uuid().required()
});

const postIdSchema = Joi.object({
  postId: Joi.string().uuid().required()
});

// Get comments for a post
router.get('/post/:postId', optionalAuthMiddleware, validateParams(postIdSchema), validateQuery(getCommentsQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { postId } = req.params;
  const {
    page = 1,
    limit = 20,
    sortBy = 'created_at',
    sortOrder = 'asc'
  } = req.query as any;

  const offset = (page - 1) * limit;

  // Get top-level comments (parent_id IS NULL)
  const { data: topLevel, error, count } = await supabase
    .from('comments')
    .select(`
      *,
      author:users!author_id(
        id,
        name,
        avatar_url,
        role,
        is_verified
      )
    `, { count: 'exact' })
    .eq('post_id', postId)
    .is('parent_id', null)
    .range(offset, offset + limit - 1)
    .order(sortBy, { ascending: sortOrder === 'asc' });

  console.log('Raw Supabase query result:', JSON.stringify(topLevel?.[0], null, 2)); // Debug log

  if (error) {
    console.log('Supabase query error:', error); // Debug log
    res.status(400).json({
      success: false,
      error: 'Failed to fetch comments'
    });
    return;
  }

  // Fetch child comments and group by parent_id
  const parentIds = (topLevel || []).map((c: any) => c.id);
  let repliesByParent: Record<string, any[]> = {};
  if (parentIds.length > 0) {
    const { data: repliesData } = await supabase
      .from('comments')
      .select(`
        *,
        author:users!author_id(
          id,
          name,
          avatar_url,
          role,
          is_verified
        )
      `)
      .in('parent_id', parentIds);
    if (Array.isArray(repliesData)) {
      repliesByParent = repliesData.reduce((acc: Record<string, any[]>, r: any) => {
        const pid = r.parent_id as string;
        if (!acc[pid]) acc[pid] = [];
        acc[pid].push(r);
        return acc;
      }, {});
    }
  }

  // Attach replies to parents
  const processedComments = (topLevel || []).map((comment: any) => ({
    ...comment,
    replies: repliesByParent[comment.id] || []
  }));

  const totalPages = Math.ceil((count || 0) / limit);

  console.log('Processed comments before sending:', JSON.stringify(processedComments?.[0], null, 2)); // Debug log

  res.json({
    success: true,
    comments: processedComments,
    pagination: {
      currentPage: page,
      totalPages,
      totalComments: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Get single comment by ID
router.get('/:id', optionalAuthMiddleware, validateParams(commentIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const { data: comment, error } = await supabase
    .from('comments')
    .select(`
      *,
      author:users!author_id(
        id,
        name,
        avatar_url,
        role,
        is_verified
      ),
      post:posts!post_id(
        id,
        content,
        author_id
      )
    `)
    .eq('id', id)
    .single();

  if (error || !comment) {
    res.status(404).json({
      success: false,
      error: 'Comment not found'
    });
    return;
  }

  // Check if user has liked the comment
  // Comment likes not supported in current schema

  res.json({
    success: true,
    comment: {
      ...comment,
      // likes fields omitted
    }
  });
}));

// Create new comment
router.post('/', authenticateToken, validate(createCommentSchema), moderateContent, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { postId, content, parentId } = req.body;

  // Check if post exists
  const { data: post, error: postError } = await supabaseAdmin
    .from('posts')
    .select('id, author_id')
    .eq('id', postId)
    .single();

  if (postError || !post) {
    res.status(404).json({
      success: false,
      error: 'Post not found'
    });
    return;
  }

  // Note: allow_comments not present in current schema; all posts allow comments

  // If this is a reply, check if parent comment exists
  if (parentId) {
    const { data: parentComment, error: parentError } = await supabaseAdmin
      .from('comments')
      .select('id, post_id')
      .eq('id', parentId)
      .single();

    if (parentError || !parentComment) {
      res.status(404).json({
        success: false,
        error: 'Parent comment not found'
      });
      return;
    }

    if (parentComment.post_id !== postId) {
      res.status(400).json({
        success: false,
        error: 'Parent comment does not belong to this post'
      });
      return;
    }
  }

  const commentId = uuidv4();

  const { data: comment, error } = await supabaseAdmin
    .from('comments')
    .insert({
      id: commentId,
      post_id: postId,
      author_id: req.user!.id,
      content,
      parent_id: parentId || null,
      created_at: new Date().toISOString()
    })
    .select(`
      *,
      author:users!author_id(
        id,
        name,
        avatar_url,
        role,
        is_verified
      )
    `)
    .single();

  if (error) {
    console.error('Create comment error:', error);
    res.status(400).json({
      success: false,
      error: 'Failed to create comment',
      details: (error as any).message || error
    });
    return;
  }

  // Create notification for post author (if not self-comment)
  if (post.author_id !== req.user!.id) {
    const { data: notif } = await supabaseAdmin
      .from('notifications')
      .insert({
        user_id: post.author_id,
        type: 'comment',
        title: 'New Comment',
        message: 'Someone commented on your post',
        data: { postId, commentId, userId: req.user!.id },
        from_user_id: req.user!.id,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    const socketHandlers = req.app.locals.socketHandlers;
    if (socketHandlers && notif) {
      socketHandlers.sendNotificationToUser(post.author_id, notif);
    }
  }

  // Increment comments_count on the post
  const { count: commentsCount } = await supabaseAdmin
    .from('comments')
    .select('id', { count: 'exact', head: true })
    .eq('post_id', postId);
  await supabaseAdmin
    .from('posts')
    .update({ comments_count: commentsCount || 0, updated_at: new Date().toISOString() })
    .eq('id', postId);

  // Award tokens for commenting
  await supabaseAdmin.rpc('add_user_tokens', {
    user_id_param: req.user!.id,
    amount_param: 2
  });

  res.status(201).json({
    success: true,
    message: 'Comment created successfully',
    comment
  });
}));

// Update comment
router.put('/:id', authenticateToken, validateParams(commentIdSchema), validate(updateCommentSchema), moderateContent, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { content } = req.body;

  // Check if user owns the comment
  const { data: existingComment, error: fetchError } = await supabaseAdmin
    .from('comments')
    .select('author_id')
    .eq('id', id)
    .single();

  if (fetchError || !existingComment) {
    res.status(404).json({
      success: false,
      error: 'Comment not found'
    });
    return;
  }

  if (existingComment.author_id !== req.user!.id) {
    res.status(403).json({
      success: false,
      error: 'Not authorized to update this comment'
    });
    return;
  }

  const { data: updatedComment, error } = await supabaseAdmin
    .from('comments')
    .update({
      content,
      updated_at: new Date().toISOString(),
      is_edited: true
    })
    .eq('id', id)
    .select(`
      *,
      author:users!author_id(
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
      error: 'Failed to update comment'
    });
    return;
  }

  res.json({
    success: true,
    message: 'Comment updated successfully',
    comment: updatedComment
  });
}));

// Delete comment
router.delete('/:id', authenticateToken, validateParams(commentIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  // Check if user owns the comment
  const { data: existingComment, error: fetchError } = await supabaseAdmin
    .from('comments')
    .select('author_id, post_id')
    .eq('id', id)
    .single();

  if (fetchError || !existingComment) {
    res.status(404).json({
      success: false,
      error: 'Comment not found'
    });
    return;
  }

  // Check if user owns the comment or the post
  const { data: post } = await supabaseAdmin
    .from('posts')
    .select('author_id')
    .eq('id', existingComment.post_id)
    .single();

  const canDelete = existingComment.author_id === req.user!.id || 
                   (post && post.author_id === req.user!.id);

  if (!canDelete) {
    res.status(403).json({
      success: false,
      error: 'Not authorized to delete this comment'
    });
    return;
  }

  const { error } = await supabaseAdmin
    .from('comments')
    .delete()
    .eq('id', id);

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to delete comment'
    });
    return;
  }

  // Recalculate and update post comments_count after delete
  const { count: commentsCountAfter } = await supabaseAdmin
    .from('comments')
    .select('id', { count: 'exact', head: true })
    .eq('post_id', existingComment.post_id);
  await supabaseAdmin
    .from('posts')
    .update({ comments_count: commentsCountAfter || 0, updated_at: new Date().toISOString() })
    .eq('id', existingComment.post_id);

  res.json({
    success: true,
    message: 'Comment deleted successfully'
  });
}));

// Like/Unlike comment
router.post('/:id/like', authenticateToken, validateParams(commentIdSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id: commentId } = req.params;
  const userId = req.user!.id;

  // Check if comment exists
  const { data: comment, error: commentError } = await supabaseAdmin
    .from('comments')
    .select('id, user_id')
    .eq('id', commentId)
    .single();

  if (commentError || !comment) {
    res.status(404).json({
      success: false,
      error: 'Comment not found'
    });
    return;
  }

  // Check if already liked
  const { data: existingLike } = await supabase
    .from('comment_likes')
    .select('id')
    .eq('comment_id', commentId)
    .eq('user_id', userId)
    .single();

  if (existingLike) {
    // Unlike the comment
    const { error: unlikeError } = await supabase
      .from('comment_likes')
      .delete()
      .eq('comment_id', commentId)
      .eq('user_id', userId);

    if (unlikeError) {
      res.status(400).json({
        success: false,
        error: 'Failed to unlike comment'
      });
      return;
    }

    res.json({
      success: true,
      message: 'Comment unliked successfully',
      liked: false
    });
    return;
  } else {
    // Like the comment
    const { error: likeError } = await supabase
      .from('comment_likes')
      .insert({
        comment_id: commentId,
        user_id: userId,
        created_at: new Date().toISOString()
      });

    if (likeError) {
      res.status(400).json({
        success: false,
        error: 'Failed to like comment'
      });
      return;
    }

    // Create notification for comment author (if not self-like)
    if (comment.user_id !== userId) {
      await supabase
        .from('notifications')
        .insert({
          user_id: comment.user_id,
          type: 'comment_like',
          title: 'Comment Liked',
          message: `Someone liked your comment`,
          data: { commentId, userId },
          created_at: new Date().toISOString()
        });
    }

    res.json({
      success: true,
      message: 'Comment liked successfully',
      liked: true
    });
  }
}));

// Get replies for a comment
router.get('/:id/replies', optionalAuthMiddleware, validateParams(commentIdSchema), validateQuery(getCommentsQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id: parentId } = req.params;
  const {
    page = 1,
    limit = 20,
    sortBy = 'created_at',
    sortOrder = 'asc'
  } = req.query as any;

  const offset = (page - 1) * limit;

  const { data: replies, error, count } = await supabase
    .from('comments')
    .select(`
      *,
      author:users!comments_user_id_fkey(
        id,
        name,
        avatar_url,
        role,
        is_verified
      ),
      likes:comment_likes(count)
    `, { count: 'exact' })
    .eq('parent_id', parentId)
    .range(offset, offset + limit - 1)
    .order(sortBy, { ascending: sortOrder === 'asc' });

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch replies'
    });
    return;
  }

  // Process replies to add user interaction flags and extract count values
  const processedReplies = await Promise.all(
    (replies || []).map(async (reply) => {
      let isLikedByUser = false;
      
      if (req.user) {
        const { data: like } = await supabase
          .from('comment_likes')
          .select('id')
          .eq('comment_id', reply.id)
          .eq('user_id', req.user.id)
          .single();
        
        isLikedByUser = !!like;
      }

      return {
        ...reply,
        likes_count: reply.likes?.[0]?.count || 0,
        likes: reply.likes?.[0]?.count || 0,
        isLikedByUser
      };
    })
  );

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    replies: processedReplies,
    pagination: {
      currentPage: page,
      totalPages,
      totalReplies: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

export default router;