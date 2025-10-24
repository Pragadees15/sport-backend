import express, { Request, Response, NextFunction } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { supabaseAdmin } from '../config/supabase';
import { migrateSportsCategories } from '../utils/migrateSportsCategories';

const router = express.Router();

// Middleware to check if user is admin
const requireAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', authReq.user!.id)
      .single();

    if (error || !user || user.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
      return;
    }

    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to verify admin status'
    });
    return;
  }
};

// Migrate sports categories endpoint
router.post('/sports-categories', authenticateToken, requireAdmin, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    console.log(`Admin ${authReq.user!.id} initiated sports categories migration`);
    
    const result = await migrateSportsCategories();
    
    res.json({
      success: true,
      message: 'Sports categories migration completed successfully',
      data: result
    });
  } catch (error) {
    console.error('Migration failed:', error);
    res.status(500).json({
      success: false,
      error: 'Migration failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

// Get migration status endpoint
router.get('/sports-categories/status', authenticateToken, requireAdmin, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    // Check current state of sports categories
    const { data: userCategories } = await supabaseAdmin
      .rpc('exec_sql', {
        sql: "SELECT DISTINCT unnest(sports_categories) as category FROM users WHERE sports_categories IS NOT NULL AND array_length(sports_categories, 1) > 0 ORDER BY category"
      });
    
    const { data: postCategories } = await supabaseAdmin
      .rpc('exec_sql', {
        sql: "SELECT DISTINCT sports_category FROM posts WHERE sports_category IS NOT NULL ORDER BY sports_category"
      });
    
    const { data: sportsCategories } = await supabaseAdmin
      .from('sports_categories')
      .select('name')
      .order('name');
    
    // Check if migration is needed
    const allowedCategories = ['Coco', 'Martial Arts', 'Calorie Fight'];
    const currentUserCategories = userCategories?.map((c: any) => c.category) || [];
    const currentPostCategories = postCategories?.map((c: any) => c.sports_category) || [];
    const currentSportsCategories = sportsCategories?.map(c => c.name) || [];
    
    const hasUnwantedUserCategories = currentUserCategories.some((cat: string) => !allowedCategories.includes(cat));
    const hasUnwantedPostCategories = currentPostCategories.some((cat: string) => !allowedCategories.includes(cat));
    const hasUnwantedSportsCategories = currentSportsCategories.some((cat: string) => !allowedCategories.includes(cat));
    
    const migrationNeeded = hasUnwantedUserCategories || hasUnwantedPostCategories || hasUnwantedSportsCategories;
    
    res.json({
      success: true,
      migrationNeeded,
      currentState: {
        userCategories: currentUserCategories,
        postCategories: currentPostCategories,
        sportsCategories: currentSportsCategories
      },
      allowedCategories,
      issues: {
        hasUnwantedUserCategories,
        hasUnwantedPostCategories,
        hasUnwantedSportsCategories
      }
    });
  } catch (error) {
    console.error('Failed to check migration status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check migration status',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

export default router;