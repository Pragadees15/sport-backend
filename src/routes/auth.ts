import express, { Request, Response } from 'express';
import { supabase, supabaseAdmin } from '../config/supabase';
import { validate } from '../middleware/validation';
import { authenticateToken } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import Joi from 'joi';

const router = express.Router();

// Validation schemas
const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  name: Joi.string().min(2).max(50).required(),
  role: Joi.string().valid('user', 'admin', 'moderator', 'coach', 'fan', 'aspirant', 'administrator').required(),
  gender: Joi.string().valid('male', 'female', 'other', 'prefer-not-to-say').required(),
  dateOfBirth: Joi.date().max('now').required(),
  location: Joi.string().max(100),
  bio: Joi.string().max(500),
  sportsCategories: Joi.array().items(Joi.string()).min(1).required(),
  accessibilityNeeds: Joi.array().items(Joi.string()),
  emergencyContact: Joi.object({
    name: Joi.string().required(),
    phone: Joi.string().required(),
    relationship: Joi.string().required()
  }),
  sportRoles: Joi.array().items(Joi.string()),
  referralCode: Joi.string().optional()
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required()
});

const updateProfileSchema = Joi.object({
  name: Joi.string().min(2).max(50),
  username: Joi.string().min(3).max(50).pattern(/^[a-zA-Z0-9_]+$/),
  role: Joi.string().valid('user', 'admin', 'moderator', 'coach', 'fan', 'aspirant', 'administrator'),
  gender: Joi.string().valid('male', 'female', 'other', 'prefer-not-to-say'),
  date_of_birth: Joi.date().max('now'),
  phone: Joi.string(),
  bio: Joi.string().max(500),
  location: Joi.string().max(100),
  sports_categories: Joi.array().items(Joi.string()),
  accessibility_needs: Joi.array().items(Joi.string()),
  emergency_contact: Joi.object({
    name: Joi.string().required(),
    phone: Joi.string().required(),
    relationship: Joi.string().required()
  }),
  sport_roles: Joi.array().items(Joi.string()),
  is_private: Joi.boolean(),
  allow_location_sharing: Joi.boolean(),
  push_notifications: Joi.boolean(),
  email_notifications: Joi.boolean(),
  privacyMode: Joi.boolean(),
  darkMode: Joi.boolean(),
  avatar_url: Joi.string().uri()
});

// Register new user
router.post('/register', validate(registerSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const {
    email,
    password,
    name,
    role,
    gender,
    dateOfBirth,
    location,
    bio,
    sportsCategories,
    accessibilityNeeds,
    emergencyContact,
    sportRoles,
    referralCode
  } = req.body;

  // Check if user already exists
  const { data: existingUser } = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .single();

  if (existingUser) {
    res.status(400).json({
      success: false,
      error: 'User already exists with this email'
    });
    return;
  }

  // Validate referral code if provided
  let referrerUserId: string | null = null;
  if (referralCode) {
    const { data: referralData, error: referralError } = await supabaseAdmin
      .from('referral_codes')
      .select('user_id, is_active, uses_count')
      .eq('code', referralCode)
      .eq('is_active', true)
      .single();

    if (referralError || !referralData) {
      res.status(400).json({
        success: false,
        error: 'Invalid or inactive referral code'
      });
      return;
    }

    referrerUserId = referralData.user_id;
  }

  // Create user in Supabase Auth
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  if (authError) {
    res.status(400).json({
      success: false,
      error: authError.message
    });
    return;
  }

  const newUserId = authData.user.id;

  // Wait a moment for the trigger to create the user profile
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Update the user profile with additional information
  const { data: userProfile, error: profileError } = await supabaseAdmin
    .from('users')
    .update({
      name,
      role,
      gender,
      date_of_birth: dateOfBirth,
      location,
      bio,
      sports_categories: sportsCategories,
      accessibility_needs: accessibilityNeeds,
      emergency_contact: emergencyContact,
      sport_roles: sportRoles,
      updated_at: new Date().toISOString()
    })
    .eq('id', newUserId)
    .select()
    .single();

  if (profileError) {
    console.error('Profile update error:', profileError);
    // Clean up auth user if profile update fails
    await supabaseAdmin.auth.admin.deleteUser(newUserId);
    res.status(400).json({
       success: false,
       error: 'Failed to update user profile'
     });
     return;
  }

  // Process referral rewards if referral code was provided
  if (referrerUserId) {
    try {
      const referralReward = 50;
      const newUserReward = 50;

      // Get referrer's current balance
      const { data: referrerTokens } = await supabaseAdmin
        .from('user_tokens')
        .select('balance, total_earned')
        .eq('user_id', referrerUserId)
        .single();

      const referrerBalance = referrerTokens?.balance || 100;
      const referrerTotalEarned = referrerTokens?.total_earned || 100;

      // Get new user's current balance
      const { data: newUserTokens } = await supabaseAdmin
        .from('user_tokens')
        .select('balance, total_earned')
        .eq('user_id', newUserId)
        .single();

      const newUserBalance = newUserTokens?.balance || 100;
      const newUserTotalEarned = newUserTokens?.total_earned || 100;

      // Award tokens to referrer using add_user_tokens function
      await supabaseAdmin.rpc('add_user_tokens', {
        user_id_param: referrerUserId,
        amount_param: referralReward
      });

      // Award tokens to new user using add_user_tokens function
      await supabaseAdmin.rpc('add_user_tokens', {
        user_id_param: newUserId,
        amount_param: newUserReward
      });

      // Increment referral code usage
      await supabaseAdmin.rpc('increment_referral_uses', {
        referral_code_param: referralCode
      });

      // Record transactions
      await supabaseAdmin.from('token_transactions').insert([
        {
          to_user_id: referrerUserId,
          amount: referralReward,
          type: 'referral',
          description: `Referral reward: ${name} signed up using your code`,
          created_at: new Date().toISOString()
        },
        {
          to_user_id: newUserId,
          amount: newUserReward,
          type: 'referral_signup',
          description: `Welcome bonus for signing up with referral code ${referralCode}`,
          created_at: new Date().toISOString()
        }
      ]);

      // Create notifications
      await supabaseAdmin.from('notifications').insert([
        {
          user_id: referrerUserId,
          type: 'system',
          title: 'Referral Successful!',
          message: `🎉 ${name} signed up using your referral code! You earned ${referralReward} tokens.`,
          data: { amount: referralReward, newUserId },
          created_at: new Date().toISOString()
        },
        {
          user_id: newUserId,
          type: 'system',
          title: 'Welcome Bonus!',
          message: `Welcome to SportsFeed! You received ${newUserReward} tokens for signing up with a referral code.`,
          data: { amount: newUserReward, referralCode },
          created_at: new Date().toISOString()
        }
      ]);
    } catch (referralError) {
      console.error('Referral processing error:', referralError);
      // Don't fail registration if referral processing fails
    }
  }

  res.status(201).json({
    success: true,
    message: 'User registered successfully',
    user: {
      id: userProfile.id,
      email: userProfile.email,
      name: userProfile.name,
      role: userProfile.role
    }
  });
}));

// Login user
router.post('/login', validate(loginSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  // Authenticate with Supabase using admin client
  const { data: authData, error: authError } = await supabaseAdmin.auth.signInWithPassword({
    email,
    password
  });

  if (authError) {
    res.status(401).json({
      success: false,
      error: 'Invalid credentials'
    });
    return;
  }

  // Get user profile using admin client to bypass RLS
  const { data: userProfile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('id', authData.user?.id)
    .single();

  if (profileError) {
    res.status(404).json({
      success: false,
      error: 'User profile not found'
    });
    return;
  }

  // Update last login using admin client
  await supabaseAdmin
    .from('users')
    .update({ last_login: new Date().toISOString() })
    .eq('id', authData.user?.id);

  res.json({
    success: true,
    message: 'Login successful',
    user: userProfile,
    session: authData.session
  });
}));

// Note: Google OAuth is now handled directly by Supabase on the frontend
// The /google endpoint has been removed as authentication is managed by Supabase's native OAuth flow

// Logout user
router.post('/logout', authenticateToken, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { error } = await supabase.auth.signOut();

  if (error) {
    res.status(400).json({
       success: false,
       error: error.message
     });
     return;
  }

  res.json({
    success: true,
    message: 'Logout successful'
  });
}));

// Get current user
router.get('/me', authenticateToken, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { data: userProfile, error } = await supabaseAdmin
    .from('users')
    .select(`
      *,
      user_tokens(*),
      followers:user_following!followed_id(count),
      following:user_following!follower_id(count)
    `)
    .eq('id', req.user!.id)
    .single();

  if (error) {
    res.status(404).json({
       success: false,
       error: 'User not found'
     });
     return;
  }

  res.json({
    success: true,
    user: userProfile
  });
}));

// Update user profile
router.put('/profile', authenticateToken, validate(updateProfileSchema), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const updates = {
    ...req.body,
    updated_at: new Date().toISOString()
  };

  // First try the update (use admin client to bypass RLS)
  const { error: updateError } = await supabaseAdmin
    .from('users')
    .update(updates)
    .eq('id', req.user!.id);

  if (updateError) {
    console.error('Profile update error:', updateError);
    res.status(400).json({
      success: false,
      error: 'Failed to update profile',
      details: updateError.message
    });
    return;
  }

  // Then fetch the updated profile (admin client ensures fresh read)
  const { data: updatedProfile, error: fetchError } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('id', req.user!.id)
    .single();

  if (fetchError) {
    console.error('Profile fetch error:', fetchError);
    res.status(400).json({
      success: false,
      error: 'Failed to fetch updated profile',
      details: fetchError.message
    });
    return;
  }



  res.json({
    success: true,
    message: 'Profile updated successfully',
    user: updatedProfile
  });
}));

// Refresh token
router.post('/refresh', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    res.status(400).json({
       success: false,
       error: 'Refresh token is required'
     });
     return;
  }

  const { data, error } = await supabase.auth.refreshSession({
    refresh_token
  });

  if (error) {
    res.status(401).json({
       success: false,
       error: 'Invalid refresh token'
     });
     return;
  }

  res.json({
    success: true,
    session: data.session
  });
}));

export default router;