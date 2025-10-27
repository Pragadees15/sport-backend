/**
 * AI Service - Free AI Integration using HuggingFace Inference API
 * 
 * This service provides:
 * 1. Content moderation and abuse detection
 * 2. Multilingual translation and language detection
 * 3. Athlete discovery with skill-based analysis
 * 4. Text classification and sentiment analysis
 * 
 * All features use FREE HuggingFace Inference API (no API key required for public models)
 */

import fetch from 'node-fetch';
import { logger } from '../utils/logger';

interface ContentModerationResult {
  isSafe: boolean;
  isAbusive: boolean;
  toxicityScore: number;
  categories: string[];
  confidence: number;
  flaggedContent: string[];
}

interface TranslationResult {
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  confidence: number;
}

interface LanguageDetectionResult {
  language: string;
  confidence: number;
  languageName: string;
}

interface AthleteAnalysisResult {
  skillLevel: number; // 0-100
  activityScore: number; // 0-100
  engagementScore: number; // 0-100
  talentScore: number; // Combined score 0-100
  strengths: string[];
  recommendations: string[];
}

class AIService {
  private readonly HF_API_BASE = 'https://api-inference.huggingface.co/models';
  
  // Free models (no API key required, or use free tier)
  private readonly MODELS = {
    // Content moderation
    toxicity: 'unitary/toxic-bert',
    // Alternative: 'facebook/roberta-hate-speech-dynabench-r4-target'
    
    // Language detection
    languageDetection: 'papluca/xlm-roberta-base-language-detection',
    
    // Translation (supports 100+ languages)
    translation: 'facebook/mbart-large-50-many-to-many-mmt',
    
    // Sentiment analysis
    sentiment: 'distilbert-base-uncased-finetuned-sst-2-english',
  };

  /**
   * Query HuggingFace Inference API (Free tier)
   */
  private async queryHuggingFace(model: string, data: any): Promise<any> {
    try {
      const response = await fetch(`${this.HF_API_BASE}/${model}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Optional: Add HF token for higher rate limits
          // 'Authorization': `Bearer ${process.env.HUGGINGFACE_TOKEN}`
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.text();
        logger.warn(`HuggingFace API error: ${error}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      logger.error('HuggingFace API request failed:', error);
      return null;
    }
  }

  /**
   * Moderate content for toxicity and abuse
   * Uses local rules + AI for comprehensive moderation
   */
  async moderateContent(text: string): Promise<ContentModerationResult> {
    try {
      // Local rule-based moderation (fast, always available)
      const localResult = this.localModeration(text);
      
      // If locally flagged, return immediately
      if (!localResult.isSafe) {
        return localResult;
      }

      // AI-based moderation for nuanced detection
      const aiResult = await this.queryHuggingFace(this.MODELS.toxicity, {
        inputs: text,
      });

      if (aiResult && Array.isArray(aiResult) && aiResult[0]) {
        const scores = aiResult[0];
        const toxicityScore = this.calculateToxicityScore(scores);
        const categories = this.extractToxicCategories(scores);

        return {
          isSafe: toxicityScore < 0.6, // Threshold
          isAbusive: toxicityScore > 0.8,
          toxicityScore,
          categories,
          confidence: 0.85,
          flaggedContent: categories.length > 0 ? [text] : [],
        };
      }

      // Fallback to local result if AI fails
      return localResult;
    } catch (error) {
      logger.error('Content moderation error:', error);
      // Safe default: use local moderation
      return this.localModeration(text);
    }
  }

  /**
   * Local rule-based moderation (no API calls)
   */
  private localModeration(text: string): ContentModerationResult {
    const lowerText = text.toLowerCase();
    
    // Comprehensive banned words/patterns
    const bannedPatterns = [
      // Hate speech
      /\b(n[i1!]gg[ea@]r|f[a@]gg[o0]t|ch[i1!]nk|sp[i1!]c|k[i1!]ke)\b/i,
      
      // Severe profanity
      /\b(f[u\*]ck|sh[i1!]t|b[i1!]tch|c[u\*]nt|d[a@]mn)\b/i,
      
      // Sexual harassment
      /\b(r[a@]pe|molest|sexual assault|dick pic|send nudes)\b/i,
      
      // Threats
      /\b(kill you|hurt you|murder|bomb|shoot you)\b/i,
      
      // Discrimination
      /\b(ret[a@]rd|mongoloid|cripple)\b/i,
    ];

    const flaggedContent: string[] = [];
    const categories: string[] = [];
    let toxicityScore = 0;

    for (const pattern of bannedPatterns) {
      if (pattern.test(text)) {
        flaggedContent.push(text);
        toxicityScore = 0.95;
        
        if (pattern.source.includes('gg') || pattern.source.includes('chink')) {
          categories.push('hate_speech');
        } else if (pattern.source.includes('rape') || pattern.source.includes('nudes')) {
          categories.push('sexual_harassment');
        } else if (pattern.source.includes('kill') || pattern.source.includes('bomb')) {
          categories.push('threat');
        } else {
          categories.push('profanity');
        }
        break;
      }
    }

    // Check for spam patterns
    if (this.isSpam(text)) {
      categories.push('spam');
      toxicityScore = Math.max(toxicityScore, 0.7);
    }

    return {
      isSafe: toxicityScore < 0.6,
      isAbusive: toxicityScore > 0.8,
      toxicityScore,
      categories: [...new Set(categories)],
      confidence: 0.9,
      flaggedContent,
    };
  }

  /**
   * Check if text is spam
   */
  private isSpam(text: string): boolean {
    // Multiple links
    const urlCount = (text.match(/https?:\/\//g) || []).length;
    if (urlCount > 3) return true;

    // Excessive repetition
    const words = text.split(/\s+/);
    const uniqueWords = new Set(words);
    if (words.length > 10 && uniqueWords.size / words.length < 0.3) return true;

    // All caps
    const capsRatio = (text.match(/[A-Z]/g) || []).length / text.length;
    if (text.length > 20 && capsRatio > 0.7) return true;

    return false;
  }

  /**
   * Calculate toxicity score from model output
   */
  private calculateToxicityScore(scores: any[]): number {
    if (!Array.isArray(scores)) return 0;
    
    const toxicLabel = scores.find(s => 
      s.label?.toLowerCase().includes('toxic') || 
      s.label?.toLowerCase().includes('hate')
    );
    
    return toxicLabel ? toxicLabel.score : 0;
  }

  /**
   * Extract toxic categories from model output
   */
  private extractToxicCategories(scores: any[]): string[] {
    if (!Array.isArray(scores)) return [];
    
    return scores
      .filter(s => s.score > 0.5)
      .map(s => s.label)
      .filter(Boolean);
  }

  /**
   * Detect language of text
   */
  async detectLanguage(text: string): Promise<LanguageDetectionResult> {
    try {
      const result = await this.queryHuggingFace(this.MODELS.languageDetection, {
        inputs: text,
      });

      if (result && Array.isArray(result) && result[0]) {
        const topResult = result[0][0]; // Get highest confidence result
        return {
          language: topResult.label,
          confidence: topResult.score,
          languageName: this.getLanguageName(topResult.label),
        };
      }

      // Fallback: detect common patterns
      return this.simpleLanguageDetection(text);
    } catch (error) {
      logger.error('Language detection error:', error);
      return this.simpleLanguageDetection(text);
    }
  }

  /**
   * Simple language detection fallback
   */
  private simpleLanguageDetection(text: string): LanguageDetectionResult {
    // Check for common non-English characters
    const hasArabic = /[\u0600-\u06FF]/.test(text);
    const hasChinese = /[\u4E00-\u9FFF]/.test(text);
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF]/.test(text);
    const hasKorean = /[\uAC00-\uD7AF]/.test(text);
    const hasCyrillic = /[\u0400-\u04FF]/.test(text);
    const hasHindi = /[\u0900-\u097F]/.test(text);

    if (hasArabic) return { language: 'ar', confidence: 0.8, languageName: 'Arabic' };
    if (hasChinese) return { language: 'zh', confidence: 0.8, languageName: 'Chinese' };
    if (hasJapanese) return { language: 'ja', confidence: 0.8, languageName: 'Japanese' };
    if (hasKorean) return { language: 'ko', confidence: 0.8, languageName: 'Korean' };
    if (hasCyrillic) return { language: 'ru', confidence: 0.7, languageName: 'Russian' };
    if (hasHindi) return { language: 'hi', confidence: 0.8, languageName: 'Hindi' };

    return { language: 'en', confidence: 0.7, languageName: 'English' };
  }

  /**
   * Get language name from code
   */
  private getLanguageName(code: string): string {
    const languages: Record<string, string> = {
      en: 'English', es: 'Spanish', fr: 'French', de: 'German',
      it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese',
      ko: 'Korean', zh: 'Chinese', ar: 'Arabic', hi: 'Hindi',
      bn: 'Bengali', ur: 'Urdu', tr: 'Turkish', vi: 'Vietnamese',
      th: 'Thai', pl: 'Polish', nl: 'Dutch', sv: 'Swedish',
    };
    return languages[code] || code.toUpperCase();
  }

  /**
   * Translate text to target language
   */
  async translateText(
    text: string,
    targetLanguage: string = 'en',
    sourceLanguage?: string
  ): Promise<TranslationResult | null> {
    try {
      // Detect source language if not provided
      if (!sourceLanguage) {
        const detection = await this.detectLanguage(text);
        sourceLanguage = detection.language;
      }

      // No translation needed
      if (sourceLanguage === targetLanguage) {
        return {
          translatedText: text,
          sourceLanguage,
          targetLanguage,
          confidence: 1.0,
        };
      }

      // Note: Free tier might have rate limits
      const result = await this.queryHuggingFace(this.MODELS.translation, {
        inputs: text,
        parameters: {
          src_lang: sourceLanguage,
          tgt_lang: targetLanguage,
        },
      });

      if (result && result[0]?.translation_text) {
        return {
          translatedText: result[0].translation_text,
          sourceLanguage: sourceLanguage!,
          targetLanguage,
          confidence: 0.85,
        };
      }

      return null;
    } catch (error) {
      logger.error('Translation error:', error);
      return null;
    }
  }

  /**
   * Analyze athlete profile for discovery and talent scoring
   */
  async analyzeAthlete(userData: {
    posts_count: number;
    followers_count: number;
    following_count: number;
    likes_received: number;
    comments_received: number;
    check_ins_count: number;
    events_attended: number;
    videos_uploaded: number;
    is_verified: boolean;
    sports_categories: string[];
    created_at: string;
    bio?: string;
  }): Promise<AthleteAnalysisResult> {
    try {
      // Calculate component scores
      const activityScore = this.calculateActivityScore(userData);
      const engagementScore = this.calculateEngagementScore(userData);
      const skillLevel = this.calculateSkillLevel(userData);
      
      // Combined talent score with weighted average
      const talentScore = (
        skillLevel * 0.4 +
        engagementScore * 0.3 +
        activityScore * 0.3
      );

      const strengths = this.identifyStrengths(userData, {
        activityScore,
        engagementScore,
        skillLevel,
      });

      const recommendations = this.generateRecommendations(userData, {
        activityScore,
        engagementScore,
        skillLevel,
      });

      return {
        skillLevel: Math.round(skillLevel),
        activityScore: Math.round(activityScore),
        engagementScore: Math.round(engagementScore),
        talentScore: Math.round(talentScore),
        strengths,
        recommendations,
      };
    } catch (error) {
      logger.error('Athlete analysis error:', error);
      // Return default scores
      return {
        skillLevel: 50,
        activityScore: 50,
        engagementScore: 50,
        talentScore: 50,
        strengths: [],
        recommendations: [],
      };
    }
  }

  /**
   * Calculate activity score (0-100)
   */
  private calculateActivityScore(userData: any): number {
    const accountAge = this.getAccountAgeDays(userData.created_at);
    const dailyPosts = userData.posts_count / Math.max(accountAge, 1);
    const dailyCheckIns = userData.check_ins_count / Math.max(accountAge, 1);
    
    // Normalize scores
    const postScore = Math.min((dailyPosts / 2) * 100, 100); // 2 posts/day = 100
    const checkInScore = Math.min((dailyCheckIns / 1) * 100, 100); // 1 check-in/day = 100
    const videoScore = Math.min((userData.videos_uploaded / 10) * 100, 100); // 10 videos = 100
    const eventScore = Math.min((userData.events_attended / 20) * 100, 100); // 20 events = 100
    
    return (postScore * 0.3 + checkInScore * 0.3 + videoScore * 0.2 + eventScore * 0.2);
  }

  /**
   * Calculate engagement score (0-100)
   */
  private calculateEngagementScore(userData: any): number {
    const avgLikesPerPost = userData.posts_count > 0 
      ? userData.likes_received / userData.posts_count 
      : 0;
    
    const avgCommentsPerPost = userData.posts_count > 0
      ? userData.comments_received / userData.posts_count
      : 0;

    const followerRatio = userData.following_count > 0
      ? Math.min(userData.followers_count / userData.following_count, 3)
      : userData.followers_count > 0 ? 3 : 0;

    // Normalize scores
    const likesScore = Math.min((avgLikesPerPost / 50) * 100, 100); // 50 likes/post = 100
    const commentsScore = Math.min((avgCommentsPerPost / 10) * 100, 100); // 10 comments/post = 100
    const followerScore = (followerRatio / 3) * 100; // 3:1 ratio = 100
    
    return (likesScore * 0.4 + commentsScore * 0.3 + followerScore * 0.3);
  }

  /**
   * Calculate skill level (0-100)
   */
  private calculateSkillLevel(userData: any): number {
    let score = 0;
    
    // Verification bonus
    if (userData.is_verified) score += 30;
    
    // Multiple sports expertise
    const sportsCount = userData.sports_categories?.length || 0;
    score += Math.min(sportsCount * 10, 20);
    
    // Content quality indicators
    if (userData.videos_uploaded > 5) score += 15;
    if (userData.events_attended > 10) score += 15;
    if (userData.followers_count > 1000) score += 20;
    
    return Math.min(score, 100);
  }

  /**
   * Identify athlete strengths
   */
  private identifyStrengths(userData: any, scores: any): string[] {
    const strengths: string[] = [];
    
    if (scores.activityScore > 70) strengths.push('Highly Active');
    if (scores.engagementScore > 70) strengths.push('Strong Community Engagement');
    if (scores.skillLevel > 70) strengths.push('Verified Expertise');
    if (userData.videos_uploaded > 10) strengths.push('Content Creator');
    if (userData.events_attended > 15) strengths.push('Event Regular');
    if (userData.followers_count > 500) strengths.push('Influencer');
    
    return strengths;
  }

  /**
   * Generate recommendations for athlete
   */
  private generateRecommendations(userData: any, scores: any): string[] {
    const recommendations: string[] = [];
    
    if (scores.activityScore < 50) {
      recommendations.push('Increase activity: Post more regularly and check in at locations');
    }
    if (scores.engagementScore < 50) {
      recommendations.push('Boost engagement: Interact more with other athletes and respond to comments');
    }
    if (!userData.is_verified && scores.skillLevel > 60) {
      recommendations.push('Apply for verification to boost credibility');
    }
    if (userData.videos_uploaded < 5) {
      recommendations.push('Upload training videos to showcase your skills');
    }
    if (userData.events_attended < 5) {
      recommendations.push('Attend more events to expand your network');
    }
    
    return recommendations;
  }

  /**
   * Get account age in days
   */
  private getAccountAgeDays(createdAt: string): number {
    const created = new Date(createdAt);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - created.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  /**
   * Analyze sentiment of text
   */
  async analyzeSentiment(text: string): Promise<{ sentiment: 'positive' | 'negative' | 'neutral'; score: number }> {
    try {
      const result = await this.queryHuggingFace(this.MODELS.sentiment, {
        inputs: text,
      });

      if (result && Array.isArray(result) && result[0]) {
        const topResult = result[0][0];
        return {
          sentiment: topResult.label.toLowerCase() as 'positive' | 'negative',
          score: topResult.score,
        };
      }

      return { sentiment: 'neutral', score: 0.5 };
    } catch (error) {
      logger.error('Sentiment analysis error:', error);
      return { sentiment: 'neutral', score: 0.5 };
    }
  }
}

export const aiService = new AIService();
export type { ContentModerationResult, TranslationResult, LanguageDetectionResult, AthleteAnalysisResult };

