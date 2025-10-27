/**
 * Content Moderation Middleware
 * 
 * Automatically moderates user-generated content using AI
 * before allowing it to be posted.
 */

import { Request, Response, NextFunction } from 'express';
import { aiService } from '../services/aiService';
import { logger } from '../utils/logger';

interface ModeratedRequest extends Request {
  moderationResult?: {
    isSafe: boolean;
    isAbusive: boolean;
    toxicityScore: number;
    categories: string[];
  };
  detectedLanguage?: {
    language: string;
    confidence: number;
  };
}

/**
 * Middleware to moderate content in request body
 * Checks for abuse, toxicity, and inappropriate content
 */
export async function moderateContent(
  req: ModeratedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { content, title, description, bio } = req.body;
    
    // Determine which field to moderate
    const textToModerate = content || title || description || bio;
    
    if (!textToModerate || typeof textToModerate !== 'string') {
      return next();
    }

    // Moderate the content
    const moderationResult = await aiService.moderateContent(textToModerate);
    
    // Store result for logging/analytics
    req.moderationResult = moderationResult;

    // Block abusive content
    if (moderationResult.isAbusive) {
      logger.warn('Abusive content detected', {
        userId: (req as any).user?.id,
        toxicityScore: moderationResult.toxicityScore,
        categories: moderationResult.categories,
      });

      res.status(403).json({
        error: 'Content violates community guidelines',
        message: 'Your content was flagged for inappropriate or abusive language. Please revise and try again.',
        categories: moderationResult.categories,
      });
      return;
    }

    // Warn about potentially toxic content but allow it
    if (!moderationResult.isSafe && moderationResult.toxicityScore > 0.6) {
      logger.info('Potentially toxic content allowed with warning', {
        userId: (req as any).user?.id,
        toxicityScore: moderationResult.toxicityScore,
      });
    }

    next();
  } catch (error) {
    logger.error('Content moderation middleware error:', error);
    // Don't block on moderation errors - fail open
    next();
  }
}

/**
 * Middleware to detect language of content
 * Useful for multilingual content and translation features
 */
export async function detectLanguage(
  req: ModeratedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { content, title, description } = req.body;
    
    const textToAnalyze = content || title || description;
    
    if (!textToAnalyze || typeof textToAnalyze !== 'string') {
      return next();
    }

    // Detect language
    const languageResult = await aiService.detectLanguage(textToAnalyze);
    
    // Store result for use in subsequent middleware/routes
    req.detectedLanguage = languageResult;

    next();
  } catch (error) {
    logger.error('Language detection middleware error:', error);
    next();
  }
}

/**
 * Combined middleware for moderation and language detection
 */
export async function moderateAndDetectLanguage(
  req: ModeratedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  await moderateContent(req, res, async () => {
    await detectLanguage(req, res, next);
  });
}

/**
 * Strict moderation for sensitive areas (e.g., messaging minors, women's lounge)
 */
export async function strictModeration(
  req: ModeratedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { content, message } = req.body;
    
    const textToModerate = content || message;
    
    if (!textToModerate || typeof textToModerate !== 'string') {
      return next();
    }

    const moderationResult = await aiService.moderateContent(textToModerate);
    
    req.moderationResult = moderationResult;

    // Stricter threshold for sensitive areas
    if (!moderationResult.isSafe || moderationResult.toxicityScore > 0.5) {
      logger.warn('Content blocked by strict moderation', {
        userId: (req as any).user?.id,
        toxicityScore: moderationResult.toxicityScore,
        categories: moderationResult.categories,
      });

      res.status(403).json({
        error: 'Content not allowed',
        message: 'Your content does not meet our safety standards for this area. Please be respectful and appropriate.',
        categories: moderationResult.categories,
      });
      return;
    }

    next();
  } catch (error) {
    logger.error('Strict moderation middleware error:', error);
    // For strict moderation, fail closed on errors
    res.status(500).json({ error: 'Unable to verify content safety at this time' });
  }
}

export default {
  moderateContent,
  detectLanguage,
  moderateAndDetectLanguage,
  strictModeration,
};

