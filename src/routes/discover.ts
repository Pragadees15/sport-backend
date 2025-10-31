import express, { Request, Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { authenticateToken, optionalAuthMiddleware } from '../middleware/auth';
import { validateQuery } from '../middleware/validation';
import { asyncHandler } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import Joi from 'joi';

const router = express.Router();

// Validation schemas
const discoverQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  search: Joi.string().max(100),
  category: Joi.string().valid('users', 'posts', 'events', 'locations', 'videos', 'all').default('all'),
  sportsCategory: Joi.string(),
  location: Joi.string(),
  verified: Joi.boolean(),
  sortBy: Joi.string().valid('recent', 'popular', 'trending', 'relevant').default('recent')
});

const trendingQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(20).default(10),
  timeframe: Joi.string().valid('day', 'week', 'month').default('week'),
  category: Joi.string().valid('posts', 'users', 'events', 'locations', 'all').default('all')
});

const recommendationsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(20).default(10),
  type: Joi.string().valid('users', 'posts', 'events', 'locations', 'all').default('all')
});

// Main discover endpoint - aggregates all content types
router.get('/', optionalAuthMiddleware, validateQuery(discoverQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 20,
    search,
    category = 'all',
    sportsCategory,
    location,
    verified,
    sortBy = 'recent'
  } = req.query as any;

  const userId = req.user?.id;
  const offset = (page - 1) * limit;

  let results: any = {
    users: [],
    posts: [],
    events: [],
    locations: [],
    videos: [],
    pagination: {
      currentPage: page,
      totalPages: 0,
      totalItems: 0,
      hasNextPage: false,
      hasPrevPage: page > 1
    }
  };

  try {
    // If searching for all categories or specific ones
    if (category === 'all' || category === 'users') {
      const usersQuery = buildUsersQuery(search, sportsCategory, location, verified, sortBy, limit, offset, userId);
      const { data: users, error: usersError, count: usersCount } = await usersQuery;
      
      if (!usersError && users) {
        // Sort users to prioritize real users over test users
        const sortedUsers = users.sort((a: any, b: any) => {
          const aIsTest = (a.email && a.email.includes('test')) || (a.username && a.username.includes('test'));
          const bIsTest = (b.email && b.email.includes('test')) || (b.username && b.username.includes('test'));
          
          // If one is test and other is not, prioritize the non-test user
          if (aIsTest && !bIsTest) return 1;
          if (!aIsTest && bIsTest) return -1;
          
          // If both are same type (both test or both real), sort by created_at (newest first)
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });
        
        results.users = await enrichUsersData(sortedUsers, userId);
        if (category === 'users') {
          results.pagination = buildPagination(page, limit, usersCount || 0);
        }
      }
    }

    if (category === 'all' || category === 'posts') {
      const postsQuery = buildPostsQuery(search, sportsCategory, sortBy, limit, offset, userId);
      const { data: posts, error: postsError, count: postsCount } = await postsQuery;
      
      if (!postsError && posts) {
        results.posts = posts;
        if (category === 'posts') {
          results.pagination = buildPagination(page, limit, postsCount || 0);
        }
      }
    }

    // NOTE: events are not available in current schema → return empty list without querying
    if (category === 'events') {
      results.events = [];
      results.pagination = buildPagination(page, limit, 0);
    }

    // NOTE: locations not available in current schema → return empty list without querying
    if (category === 'locations') {
      results.locations = [];
      results.pagination = buildPagination(page, limit, 0);
    }

    // NOTE: videos not available in current schema → return empty list without querying
    if (category === 'videos') {
      results.videos = [];
      results.pagination = buildPagination(page, limit, 0);
    }

    // If category is 'all', limit results per category for better UX
    if (category === 'all') {
      const itemsPerCategory = Math.max(1, Math.floor(limit / 5));
      results.users = (results.users || []).slice(0, itemsPerCategory);
      // Normalize posts shape for frontend expectations
      results.posts = (results.posts || []).slice(0, itemsPerCategory).map((post: any) => normalizePost(post));
      results.events = [];
      results.locations = [];
      results.videos = [];
    } else if (category === 'posts') {
      // Normalize posts when fetching posts tab
      results.posts = (results.posts || []).map((post: any) => normalizePost(post));
    }

    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch discover content'
    });
  }
}));

// Get trending content
router.get('/trending', optionalAuthMiddleware, validateQuery(trendingQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    limit = 10,
    timeframe = 'week',
    category = 'all'
  } = req.query as any;

  const userId = req.user?.id;
  const timeframeHours = timeframe === 'day' ? 24 : timeframe === 'week' ? 168 : 720; // month = 30 days
  const cutoffDate = new Date(Date.now() - timeframeHours * 60 * 60 * 1000).toISOString();

  let trending: any = {
    posts: [],
    users: [],
    events: [], // not available in current schema
    locations: [] // not available in current schema
  };

  try {
    if (category === 'all' || category === 'posts') {
      // Get trending posts based on likes, comments, and shares
      const { data: trendingPosts } = await supabase
        .from('posts')
        .select(`
          *,
          author:users!author_id(
            id,
            name,
            avatar_url,
            role,
            is_verified
          ),
          likes:post_likes(count),
          comments:comments(count),
          shares:post_shares(count)
        `)
        .gte('created_at', cutoffDate)
        .limit(limit)
        .order('created_at', { ascending: false });

      if (trendingPosts) {
        // Calculate trending score and sort
        trending.posts = trendingPosts
          .map(post => ({
            ...post,
            trending_score: (post.likes?.[0]?.count || 0) * 3 + 
                           (post.comments?.[0]?.count || 0) * 2 + 
                           (post.shares?.[0]?.count || 0) * 5
          }))
          .sort((a, b) => b.trending_score - a.trending_score)
          .slice(0, limit);
      }
    }

    if (category === 'all' || category === 'users') {
      // Get trending users based on new followers and activity
      let trendingUsersQuery = supabase
        .from('users')
        .select(`
          id,
          name,
          avatar_url,
          role,
          bio,
          sports_categories,
          is_verified,
          followers:user_following!following_id(count),
          recent_posts:posts!author_id(
            id,
            created_at
          )
        `)
        .eq('is_private', false)
        .not('username', 'is', null)  // ✅ Filter out incomplete profiles
        .not('role', 'is', null)      // ✅ Filter out incomplete profiles
        .limit(limit * 2); // Get more to filter and sort

      // Exclude current user from trending results
      if (userId) {
        trendingUsersQuery = trendingUsersQuery.neq('id', userId);
      }

      const { data: trendingUsers } = await trendingUsersQuery;

      if (trendingUsers) {
        trending.users = await enrichUsersData(
          trendingUsers
            .filter(user => {
              const recentPosts = user.recent_posts?.filter(
                (post: any) => new Date(post.created_at) >= new Date(cutoffDate)
              ) || [];
              return recentPosts.length > 0;
            })
            .slice(0, limit),
          userId
        );
      }
    }

    // events not available → leave empty

    // locations not available → leave empty

    res.json({
      success: true,
      trending,
      timeframe,
      generated_at: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch trending content'
    });
  }
}));

// Get personalized recommendations
router.get('/recommendations', authenticateToken, validateQuery(recommendationsQuerySchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    limit = 10,
    type = 'all'
  } = req.query as any;

  const userId = req.user!.id;

  let recommendations: any = {
    users: [],
    posts: [],
    events: [], // not available in current schema
    locations: [] // not available in current schema
  };

  try {
    // Get user's interests and activity
    const { data: userProfile } = await supabase
      .from('users')
      .select(`
        sports_categories,
        location,
        following:user_following!follower_id(
          followed:users!followed_id(
            sports_categories,
            location
          )
        )
      `)
      .eq('id', userId)
      .single();

    const userSportsCategories = userProfile?.sports_categories || [];
    const userLocation = userProfile?.location;

    if (type === 'all' || type === 'users') {
      // Recommend users based on similar interests and mutual connections
      let usersQuery = supabase
        .from('users')
        .select(`
          id,
          name,
          avatar_url,
          role,
          bio,
          sports_categories,
          location,
          is_verified,
          followers:user_following!followed_id(count)
        `)
        .eq('is_private', false)
        .neq('id', userId);

      // Filter by sports categories if user has them
      if (userSportsCategories.length > 0) {
        usersQuery = usersQuery.overlaps('sports_categories', userSportsCategories);
      }

      const { data: recommendedUsers } = await usersQuery.limit(limit);
      
      if (recommendedUsers) {
        recommendations.users = await enrichUsersData(recommendedUsers, userId);
      }
    }

    if (type === 'all' || type === 'posts') {
      // Recommend posts from users with similar interests
      let postsQuery = supabase
        .from('posts')
        .select(`
          *,
          author:users!author_id(
            id,
            name,
            avatar_url,
            role,
            sports_categories,
            is_verified
          ),
          likes:post_likes(count),
          comments:comments(count)
        `)
        .neq('author_id', userId)
        .order('created_at', { ascending: false });

      const { data: recommendedPosts } = await postsQuery.limit(limit * 2);
      
      if (recommendedPosts) {
        // Filter posts from users with similar sports categories
        recommendations.posts = recommendedPosts
          .filter(post => {
            const authorSports = post.author?.sports_categories || [];
            return userSportsCategories.some((sport: string) => authorSports.includes(sport));
          })
          .slice(0, limit);
      }
    }

    // events not available → leave empty

    // locations not available → leave empty

    res.json({
      success: true,
      recommendations,
      user_preferences: {
        sports_categories: userSportsCategories,
        location: userLocation
      },
      generated_at: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to generate recommendations'
    });
  }
}));

// Get discover statistics
router.get('/stats', optionalAuthMiddleware, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  try {
    const [usersResult, postsResult] = await Promise.all([
      supabaseAdmin.from('users').select('id', { count: 'exact' }).eq('is_private', false).neq('role', 'administrator'),
      supabaseAdmin.from('posts').select('id', { count: 'exact' })
    ]);

    // Get active users (posted or checked in recently) - Improved approach
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    // Get users who posted in the last week
    const { data: recentPostsUsers } = await supabaseAdmin
      .from('posts')
      .select('author_id')
      .gte('created_at', weekAgo);

    // Get users who checked in recently
    const { data: recentCheckinsUsers } = await supabaseAdmin
      .from('location_checkins')
      .select('user_id')
      .gte('created_at', weekAgo);

    // Combine and deduplicate user IDs
    const activeUserIds = new Set([
      ...(recentPostsUsers?.map(p => p.author_id) || []),
      ...(recentCheckinsUsers?.map(c => c.user_id) || [])
    ]);

    // Filter out private users and administrators
    const { data: activeUsers } = await supabaseAdmin
      .from('users')
      .select('id')
      .in('id', Array.from(activeUserIds))
      .eq('is_private', false)
      .neq('role', 'administrator');

    let activeUsersCount = activeUsers?.length || 0;

    // If no recent activity, try a broader approach - users who have been active in the last 30 days
    if (activeUsersCount === 0) {
      const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      
      const { data: recentPostsUsers30 } = await supabaseAdmin
        .from('posts')
        .select('author_id')
        .gte('created_at', monthAgo);

      const { data: recentCheckinsUsers30 } = await supabaseAdmin
        .from('location_checkins')
        .select('user_id')
        .gte('created_at', monthAgo);

      const activeUserIds30 = new Set([
        ...(recentPostsUsers30?.map(p => p.author_id) || []),
        ...(recentCheckinsUsers30?.map(c => c.user_id) || [])
      ]);

      const { data: activeUsers30 } = await supabaseAdmin
        .from('users')
        .select('id')
        .in('id', Array.from(activeUserIds30))
        .eq('is_private', false)
        .neq('role', 'administrator');

      activeUsersCount = activeUsers30?.length || 0;
    }

    // Debug logging removed to reduce noise

    // Get role-specific counts
    const [coachesResult, aspirantsResult] = await Promise.all([
      supabaseAdmin.from('users').select('id', { count: 'exact' }).eq('role', 'coach').eq('is_private', false),
      supabaseAdmin.from('users').select('id', { count: 'exact' }).eq('role', 'aspirant').eq('is_private', false)
    ]);

    // Update the response with role counts
    const statsResponse = {
      success: true,
      stats: {
        total_users: usersResult.count || 0,
        total_posts: postsResult.count || 0,
        upcoming_events: 0,
        total_locations: 0,
        total_videos: 0,
        active_users_this_week: activeUsersCount,
        coaches: coachesResult.count || 0,
        aspirants: aspirantsResult.count || 0
      },
      generated_at: new Date().toISOString()
    };

    res.json(statsResponse);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch discover statistics'
    });
  }
}));

// Helper functions
function buildUsersQuery(search: string, sportsCategory: string, location: string, verified: boolean, sortBy: string, limit: number, offset: number, currentUserId?: string) {
  let query = supabaseAdmin
    .from('users')
    .select(`
      id,
      name,
      username,
      avatar_url,
      role,
      bio,
      location,
      sports_categories,
      is_verified,
      created_at,
      followers:user_following!following_id(count)
    `, { count: 'exact' })
    .eq('is_private', false)
    .not('username', 'is', null)  // ✅ Filter out users without username (incomplete profile)
    .not('role', 'is', null)      // ✅ Filter out users without role (incomplete profile)
    .range(offset, offset + limit - 1);

  // Exclude current user from results
  if (currentUserId) {
    query = query.neq('id', currentUserId);
  }

  if (search) {
    query = query.or(`name.ilike.%${search}%,bio.ilike.%${search}%`);
  }

  if (sportsCategory) {
    query = query.contains('sports_categories', [sportsCategory]);
  }

  if (location) {
    query = query.ilike('location', `%${location}%`);
  }

  if (verified !== undefined) {
    query = query.eq('is_verified', verified);
  }

  // Apply basic sorting (we'll handle test user prioritization after fetching)
  switch (sortBy) {
    case 'popular':
      // Note: This would need a more complex query to sort by follower count
      query = query.order('created_at', { ascending: false });
      break;
    case 'recent':
    default:
      query = query.order('created_at', { ascending: false });
      break;
  }

  return query;
}

function buildPostsQuery(search: string, sportsCategory: string, sortBy: string, limit: number, offset: number, userId?: string) {
  let query = supabase
    .from('posts')
    .select(`
      *,
      author:users!author_id(
        id,
        name,
        avatar_url,
        role,
        is_verified
      ),
      likes:post_likes(count),
      comments:comments(count)
    `, { count: 'exact' })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.or(`content.ilike.%${search}%,title.ilike.%${search}%`);
  }

  if (sportsCategory) {
    query = query.contains('tags', [sportsCategory]);
  }

  // Apply sorting
  switch (sortBy) {
    case 'popular':
      // Note: This would need a more complex query to sort by engagement
      query = query.order('created_at', { ascending: false });
      break;
    case 'recent':
    default:
      query = query.order('created_at', { ascending: false });
      break;
  }

  return query;
}

function buildEventsQuery(search: string, sportsCategory: string, location: string, sortBy: string, limit: number, offset: number) {
  let query = supabase
    .from('events')
    .select(`
      *,
      organizer:users!organizer_id(
        id,
        name,
        avatar_url,
        role
      )
    `, { count: 'exact' })
    .gte('start_date', new Date().toISOString())
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
  }

  if (sportsCategory) {
    query = query.eq('category', sportsCategory);
  }

  if (location) {
    query = query.ilike('location', `%${location}%`);
  }

  // Apply sorting
  switch (sortBy) {
    case 'recent':
      query = query.order('created_at', { ascending: false });
      break;
    case 'popular':
    default:
      query = query.order('start_date', { ascending: true });
      break;
  }

  return query;
}

function buildLocationsQuery(search: string, sportsCategory: string, location: string, sortBy: string, limit: number, offset: number) {
  let query = supabase
    .from('safe_locations')
    .select(`
      *,
      created_by:users!created_by(
        id,
        name,
        avatar_url,
        role
      )
    `, { count: 'exact' })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`);
  }

  if (sportsCategory) {
    query = query.eq('category', sportsCategory);
  }

  if (location) {
    query = query.or(`address.ilike.%${location}%,name.ilike.%${location}%`);
  }

  // Apply sorting
  switch (sortBy) {
    case 'popular':
      // Note: This would need a more complex query to sort by check-ins
      query = query.order('created_at', { ascending: false });
      break;
    case 'recent':
    default:
      query = query.order('created_at', { ascending: false });
      break;
  }

  return query;
}

function buildVideosQuery(search: string, sportsCategory: string, sortBy: string, limit: number, offset: number) {
  let query = supabase
    .from('videos')
    .select(`
      *,
      coach:users!coach_id(
        id,
        name,
        avatar_url,
        role
      )
    `, { count: 'exact' })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
  }

  if (sportsCategory) {
    query = query.eq('category', sportsCategory);
  }

  // Apply sorting
  switch (sortBy) {
    case 'popular':
      // Note: This would need a more complex query to sort by views/likes
      query = query.order('created_at', { ascending: false });
      break;
    case 'recent':
    default:
      query = query.order('created_at', { ascending: false });
      break;
  }

  return query;
}

function buildPagination(page: number, limit: number, totalItems: number) {
  const totalPages = Math.ceil(totalItems / limit);
  return {
    currentPage: page,
    totalPages,
    totalItems,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1
  };
}

async function enrichUsersData(users: any[], currentUserId?: string) {
  if (!users || users.length === 0) return [];

  // If no current user, return users as-is
  if (!currentUserId) {
    return users.map(user => ({
      ...user,
      fullName: user.name,
      profileImage: user.avatar_url,
      sportsCategory: user.sports_categories?.[0],
      is_following: false,
      followers_count: user.followers?.[0]?.count || 0
    }));
  }

  // Get following relationships for current user
  const userIds = users.map(u => u.id);
  const { data: followingData } = await supabase
    .from('user_following')
    .select('following_id')
    .eq('follower_id', currentUserId)
    .in('following_id', userIds);

  const followingIds = new Set(followingData?.map(f => f.following_id) || []);

  return users.map(user => ({
    ...user,
    fullName: user.name,
    profileImage: user.avatar_url,
    sportsCategory: user.sports_categories?.[0],
    is_following: followingIds.has(user.id),
    followers_count: user.followers?.[0]?.count || 0
  }));
}

export default router;

// Helpers to normalize shapes for frontend compatibility
function normalizePost(post: any) {
  return {
    ...post,
    createdAt: post.created_at,
    updatedAt: post.updated_at,
    // Flatten counts
    likes: Array.isArray(post.likes) && post.likes[0]?.count != null ? post.likes[0].count : (post.likes_count ?? 0),
    comments: Array.isArray(post.comments) && post.comments[0]?.count != null ? post.comments[0].count : (post.comments_count ?? 0),
    shares: Array.isArray(post.shares) && post.shares[0]?.count != null ? post.shares[0].count : (post.shares_count ?? 0),
    // First media image if present
    image: Array.isArray(post.media_urls) && post.media_urls.length > 0 ? post.media_urls[0] : undefined,
    author: post.author ? {
      ...post.author,
      fullName: post.author.name,
      profileImage: post.author.avatar_url
    } : undefined
  };
}