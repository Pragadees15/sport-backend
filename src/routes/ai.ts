import { Router, Request, Response } from 'express';
import { aiService } from '../services/aiService';
import { authMiddleware } from '../middleware/auth';
import { supabase } from '../server';
import { logger } from '../utils/logger';

const router = Router();

/**
 * POST /api/ai/moderate
 * Moderate content for toxicity and abuse
 */
router.post('/moderate', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { content } = req.body;

    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    const result = await aiService.moderateContent(content);

    res.json({
      success: true,
      moderation: result,
    });
  } catch (error) {
    logger.error('Content moderation error:', error);
    res.status(500).json({ error: 'Failed to moderate content' });
  }
});

/**
 * POST /api/ai/detect-language
 * Detect language of text
 */
router.post('/detect-language', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { text } = req.body;

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Text is required' });
      return;
    }

    const result = await aiService.detectLanguage(text);

    res.json({
      success: true,
      detection: result,
    });
  } catch (error) {
    logger.error('Language detection error:', error);
    res.status(500).json({ error: 'Failed to detect language' });
  }
});

/**
 * POST /api/ai/translate
 * Translate text to target language
 */
router.post('/translate', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { text, targetLanguage, sourceLanguage } = req.body;

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Text is required' });
      return;
    }

    if (!targetLanguage || typeof targetLanguage !== 'string') {
      res.status(400).json({ error: 'Target language is required' });
      return;
    }

    const result = await aiService.translateText(text, targetLanguage, sourceLanguage);

    if (!result) {
      res.status(500).json({ error: 'Translation failed' });
      return;
    }

    res.json({
      success: true,
      translation: result,
    });
  } catch (error) {
    logger.error('Translation error:', error);
    res.status(500).json({ error: 'Failed to translate text' });
  }
});

/**
 * GET /api/ai/discover-athletes
 * Discover talented athletes using AI analysis
 */
router.get('/discover-athletes', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { 
      limit = 20, 
      minTalentScore = 60,
      sportsCategory,
      location,
      radius = 50 // km
    } = req.query;

    // Query users with activity data
    let query = supabase
      .from('users')
      .select(`
        *,
        posts:posts(count),
        followers:followers(count),
        following:following(count)
      `)
      .eq('is_banned', false)
      .limit(Number(limit));

    // Filter by sports category
    if (sportsCategory) {
      query = query.contains('sports_categories', [sportsCategory]);
    }

    const { data: users, error } = await query;

    if (error) {
      logger.error('Failed to fetch users for discovery:', error);
      res.status(500).json({ error: 'Failed to discover athletes' });
      return;
    }

    if (!users || users.length === 0) {
      res.json({
        success: true,
        athletes: [],
        total: 0,
      });
      return;
    }

    // Fetch additional stats for each user
    const enrichedUsers = await Promise.all(
      users.map(async (user) => {
        // Get likes and comments received
        const { data: postStats } = await supabase
          .from('posts')
          .select('likes_count, comments_count')
          .eq('author_id', user.id);

        const likesReceived = postStats?.reduce((sum, post) => sum + (post.likes_count || 0), 0) || 0;
        const commentsReceived = postStats?.reduce((sum, post) => sum + (post.comments_count || 0), 0) || 0;

        // Get check-ins count
        const { count: checkInsCount } = await supabase
          .from('location_check_ins')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id);

        // Get events attended
        const { count: eventsCount } = await supabase
          .from('event_participants')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id);

        // Get videos uploaded
        const { count: videosCount } = await supabase
          .from('videos')
          .select('*', { count: 'exact', head: true })
          .eq('coach_id', user.id);

        return {
          ...user,
          posts_count: user.posts?.[0]?.count || 0,
          followers_count: user.followers?.[0]?.count || 0,
          following_count: user.following?.[0]?.count || 0,
          likes_received: likesReceived,
          comments_received: commentsReceived,
          check_ins_count: checkInsCount || 0,
          events_attended: eventsCount || 0,
          videos_uploaded: videosCount || 0,
        };
      })
    );

    // Analyze each athlete with AI
    const athletesWithScores = await Promise.all(
      enrichedUsers.map(async (user) => {
        const analysis = await aiService.analyzeAthlete({
          posts_count: user.posts_count,
          followers_count: user.followers_count,
          following_count: user.following_count,
          likes_received: user.likes_received,
          comments_received: user.comments_received,
          check_ins_count: user.check_ins_count,
          events_attended: user.events_attended,
          videos_uploaded: user.videos_uploaded,
          is_verified: user.is_verified || false,
          sports_categories: user.sports_categories || [],
          created_at: user.created_at,
          bio: user.bio,
        });

        return {
          user: {
            id: user.id,
            name: user.name,
            username: user.username,
            avatar_url: user.avatar_url,
            bio: user.bio,
            location: user.location,
            sports_categories: user.sports_categories,
            is_verified: user.is_verified,
          },
          analysis,
        };
      })
    );

    // Filter by minimum talent score and sort
    const filteredAthletes = athletesWithScores
      .filter(a => a.analysis.talentScore >= Number(minTalentScore))
      .sort((a, b) => b.analysis.talentScore - a.analysis.talentScore);

    res.json({
      success: true,
      athletes: filteredAthletes,
      total: filteredAthletes.length,
    });
  } catch (error) {
    logger.error('Athlete discovery error:', error);
    res.status(500).json({ error: 'Failed to discover athletes' });
  }
});

/**
 * GET /api/ai/talent-heatmap
 * Get talent heatmap data for map visualization
 */
router.get('/talent-heatmap', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { bounds, minTalentScore = 50 } = req.query;

    // Parse bounds if provided
    let boundsFilter = null;
    if (bounds && typeof bounds === 'string') {
      try {
        boundsFilter = JSON.parse(bounds);
      } catch (e) {
        logger.warn('Invalid bounds parameter:', e);
      }
    }

    // Get recent check-ins with user data
    let query = supabase
      .from('location_check_ins')
      .select(`
        id,
        user_id,
        latitude,
        longitude,
        created_at,
        users!inner(
          id,
          name,
          sports_categories,
          is_verified
        )
      `)
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()) // Last 7 days
      .limit(500);

    const { data: checkIns, error } = await query;

    if (error) {
      logger.error('Failed to fetch check-ins for heatmap:', error);
      res.status(500).json({ error: 'Failed to generate heatmap' });
      return;
    }

    if (!checkIns || checkIns.length === 0) {
      res.json({
        success: true,
        heatmapData: [],
        total: 0,
      });
      return;
    }

    // Group by location and calculate talent density
    const locationMap = new Map<string, any>();

    for (const checkIn of checkIns) {
      const locationKey = `${checkIn.latitude.toFixed(4)},${checkIn.longitude.toFixed(4)}`;
      
      if (!locationMap.has(locationKey)) {
        locationMap.set(locationKey, {
          latitude: checkIn.latitude,
          longitude: checkIn.longitude,
          users: [],
          checkIns: [],
        });
      }

      const location = locationMap.get(locationKey);
      location.users.push(checkIn.users);
      location.checkIns.push(checkIn);
    }

    // Calculate talent scores for each location
    const heatmapData = await Promise.all(
      Array.from(locationMap.entries()).map(async ([key, location]) => {
        // Get unique users at this location
        const uniqueUsers = Array.from(
          new Map(location.users.map((u: any) => [u.id, u])).values()
        );

        // Simplified talent calculation based on verification and activity
        let totalTalent = 0;
        for (const user of uniqueUsers) {
          let userTalent = 50; // Base score
          const typedUser = user as any;
          if (typedUser.is_verified) userTalent += 30;
          if (typedUser.sports_categories?.length > 1) userTalent += 10;
          if (location.checkIns.filter((c: any) => c.user_id === typedUser.id).length > 2) {
            userTalent += 10;
          }
          totalTalent += userTalent;
        }

        const avgTalent = uniqueUsers.length > 0 ? totalTalent / uniqueUsers.length : 0;

        return {
          id: key,
          latitude: location.latitude,
          longitude: location.longitude,
          intensity: Math.min(avgTalent / 100, 1), // Normalize to 0-1
          talentScore: Math.round(avgTalent),
          userCount: uniqueUsers.length,
          checkInCount: location.checkIns.length,
          type: 'talent' as const,
          topAthletes: uniqueUsers
            .slice(0, 3)
            .map((u: any) => ({
              id: u.id,
              name: u.name,
              is_verified: u.is_verified,
            })),
        };
      })
    );

    // Filter by minimum talent score
    const filteredData = heatmapData.filter(d => d.talentScore >= Number(minTalentScore));

    res.json({
      success: true,
      heatmapData: filteredData,
      total: filteredData.length,
    });
  } catch (error) {
    logger.error('Talent heatmap error:', error);
    res.status(500).json({ error: 'Failed to generate talent heatmap' });
  }
});

/**
 * POST /api/ai/analyze-sentiment
 * Analyze sentiment of text
 */
router.post('/analyze-sentiment', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { text } = req.body;

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Text is required' });
      return;
    }

    const result = await aiService.analyzeSentiment(text);

    res.json({
      success: true,
      sentiment: result,
    });
  } catch (error) {
    logger.error('Sentiment analysis error:', error);
    res.status(500).json({ error: 'Failed to analyze sentiment' });
  }
});

export default router;

