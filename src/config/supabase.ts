import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  throw new Error('Missing Supabase environment variables: SUPABASE_URL or SUPABASE_ANON_KEY');
}

// Enforce presence of service role key for backend admin operations
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  // Fail fast in non-test environments to avoid confusing RLS-related 403s
  const isTest = process.env.NODE_ENV === 'test';
  if (!isTest) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY. Set the service role key to allow server-side RLS bypass.');
  }
}

// Client for general operations (with RLS)
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Admin client for server-side operations (bypasses RLS)
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  // Use only the service role key; never fall back to anon key for admin client
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Database table names
export const TABLES = {
  USERS: 'users',
  POSTS: 'posts',
  COMMENTS: 'comments',
  MESSAGES: 'messages',
  CONVERSATIONS: 'conversations',
  CONVERSATION_PARTICIPANTS: 'conversation_participants',
  NOTIFICATIONS: 'notifications',
  VIDEOS: 'videos',
  MEMBERSHIPS: 'memberships',
  USER_TOKENS: 'user_tokens',
  TOKEN_TRANSACTIONS: 'token_transactions',
  LOCATION_CHECKINS: 'location_checkins',
  SAFE_LOCATIONS: 'safe_locations',
  HEATMAP_DATA: 'heatmap_data',
  EVENTS: 'events',
  VERIFICATION_DOCUMENTS: 'verification_documents',
  EVIDENCE_DOCUMENTS: 'evidence_documents',
  USER_FOLLOWING: 'user_following',
  POST_LIKES: 'post_likes',
  POST_SHARES: 'post_shares'
} as const;

// Helper function to get authenticated user from request
export const getAuthenticatedUser = async (authHeader?: string) => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return null;
    }
    return user;
  } catch (error) {
    console.error('Error getting authenticated user:', error);
    return null;
  }
};