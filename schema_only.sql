


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."add_user_tokens"("user_id_param" "uuid", "amount_param" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    -- Update user's token balance
    UPDATE users 
    SET tokens = tokens + amount_param,
        updated_at = NOW()
    WHERE id = user_id_param;
    
    -- Update user_tokens record
    UPDATE user_tokens 
    SET balance = balance + amount_param,
        total_earned = total_earned + amount_param,
        updated_at = NOW()
    WHERE user_id = user_id_param;
    
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$$;


ALTER FUNCTION "public"."add_user_tokens"("user_id_param" "uuid", "amount_param" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."add_user_xp"("user_id_param" "uuid", "xp_amount" integer, "source_type_param" "text" DEFAULT 'activity'::"text", "source_id_param" "uuid" DEFAULT NULL::"uuid", "description_param" "text" DEFAULT NULL::"text") RETURNS TABLE("new_level" integer, "leveled_up" boolean, "xp_to_next" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    current_level INTEGER;
    current_xp INTEGER;
    total_xp INTEGER;
    xp_needed INTEGER;
    new_level INTEGER := 0;
    leveled BOOLEAN := false;
    remaining_xp INTEGER;
    new_xp_to_next INTEGER;
BEGIN
    -- Get or initialize user level data
    INSERT INTO public.user_levels (user_id, level, current_xp, total_xp, xp_to_next_level)
    VALUES (user_id_param, 1, 0, 0, 100)
    ON CONFLICT (user_id) DO NOTHING;
    
    -- Get current stats
    SELECT level, current_xp, total_xp, xp_to_next_level
    INTO current_level, current_xp, total_xp, xp_needed
    FROM public.user_levels
    WHERE user_id = user_id_param;
    
    -- Add XP
    total_xp := total_xp + xp_amount;
    remaining_xp := current_xp + xp_amount;
    new_level := current_level;
    
    -- Level up loop
    WHILE remaining_xp >= xp_needed LOOP
        remaining_xp := remaining_xp - xp_needed;
        new_level := new_level + 1;
        xp_needed := calculate_xp_for_level(new_level);
        leveled := true;
    END LOOP;
    
    -- Calculate XP to next level
    new_xp_to_next := GREATEST(0, xp_needed - remaining_xp);
    
    -- Update user_levels
    UPDATE public.user_levels
    SET
        level = new_level,
        current_xp = remaining_xp,
        total_xp = total_xp,
        xp_to_next_level = new_xp_to_next,
        updated_at = NOW()
    WHERE user_id = user_id_param;
    
    -- Record XP transaction
    INSERT INTO public.xp_transactions (user_id, amount, source_type, source_id, description)
    VALUES (user_id_param, xp_amount, source_type_param, source_id_param, description_param);
    
    -- If leveled up, create notification
    IF leveled THEN
        INSERT INTO public.notifications (user_id, type, title, message, data, created_at)
        VALUES (
            user_id_param,
            'system',
            'Level Up! 🎉',
            'Congratulations! You reached level ' || new_level || '!',
            jsonb_build_object('level', new_level, 'type', 'level_up'),
            NOW()
        );
    END IF;
    
    RETURN QUERY SELECT new_level, leveled, new_xp_to_next;
END;
$$;


ALTER FUNCTION "public"."add_user_xp"("user_id_param" "uuid", "xp_amount" integer, "source_type_param" "text", "source_id_param" "uuid", "description_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."calculate_xp_for_level"("level" integer) RETURNS integer
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
BEGIN
    -- Exponential growth: 100 * (level^1.5)
    RETURN GREATEST(100, FLOOR(100 * POWER(level::numeric, 1.5))::integer);
END;
$$;


ALTER FUNCTION "public"."calculate_xp_for_level"("level" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_and_award_achievements"("user_id_param" "uuid", "achievement_type_param" "text", "current_value_param" integer) RETURNS TABLE("achievement_id" "uuid", "achievement_code" character varying, "unlocked" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    achievement_rec RECORD;
    existing_achievement RECORD;
    unlocked_bool BOOLEAN;
BEGIN
    -- Find all active achievements matching the type and value threshold
    FOR achievement_rec IN
        SELECT *
        FROM public.achievements
        WHERE is_active = true
            AND requirement_type = achievement_type_param
            AND requirement_value <= current_value_param
            AND id NOT IN (
                SELECT achievement_id
                FROM public.user_achievements
                WHERE user_id = user_id_param
            )
    LOOP
        unlocked_bool := true;
        
        -- Insert user achievement
        INSERT INTO public.user_achievements (user_id, achievement_id, progress, unlocked_at)
        VALUES (user_id_param, achievement_rec.id, current_value_param, NOW())
        ON CONFLICT (user_id, achievement_id) DO NOTHING;
        
        -- If successfully inserted, award XP and tokens
        IF FOUND THEN
            -- Award XP
            PERFORM add_user_xp(
                user_id_param,
                achievement_rec.xp_reward,
                'achievement',
                achievement_rec.id,
                'Achievement unlocked: ' || achievement_rec.name
            );
            
            -- Award tokens
            IF achievement_rec.token_reward > 0 THEN
                PERFORM add_user_tokens(user_id_param, achievement_rec.token_reward);
            END IF;
            
            -- Create notification
            INSERT INTO public.notifications (user_id, type, title, message, data, created_at)
            VALUES (
                user_id_param,
                'achievement',
                'Achievement Unlocked! 🏆',
                achievement_rec.name || ': ' || achievement_rec.description,
                jsonb_build_object(
                    'achievement_id', achievement_rec.id,
                    'achievement_code', achievement_rec.code,
                    'xp_reward', achievement_rec.xp_reward,
                    'token_reward', achievement_rec.token_reward
                ),
                NOW()
            );
        END IF;
        
        RETURN QUERY SELECT achievement_rec.id, achievement_rec.code, unlocked_bool;
    END LOOP;
END;
$$;


ALTER FUNCTION "public"."check_and_award_achievements"("user_id_param" "uuid", "achievement_type_param" "text", "current_value_param" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_user_referral_code"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  new_code VARCHAR(20);
  code_exists BOOLEAN;
BEGIN
  -- Generate unique code using last 8 chars of UUID
  new_code := 'SPORT' || UPPER(SUBSTRING(REPLACE(NEW.id::text, '-', ''), 25, 8));
  
  -- Check if code already exists (unlikely but possible)
  SELECT EXISTS(SELECT 1 FROM public.referral_codes WHERE code = new_code) INTO code_exists;
  
  -- If code exists, append random suffix
  IF code_exists THEN
    new_code := new_code || FLOOR(RANDOM() * 100)::text;
  END IF;
  
  -- Insert referral code
  INSERT INTO public.referral_codes (code, user_id, created_at, uses_count, is_active)
  VALUES (new_code, NEW.id, NOW(), 0, true)
  ON CONFLICT (code) DO NOTHING;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."create_user_referral_code"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_home_feed"("user_id_param" "uuid", "feed_filter" "text", "page" integer DEFAULT 1, "page_size" integer DEFAULT 10, "sort_by" "text" DEFAULT 'created_at'::"text", "sort_order" "text" DEFAULT 'desc'::"text") RETURNS TABLE("post_id" "uuid", "author_id" "uuid", "content" "text", "media_urls" "jsonb", "likes_count" integer, "shares_count" integer, "comments_count" integer, "created_at" timestamp with time zone, "updated_at" timestamp with time zone, "author_name" "text", "author_username" "text", "author_avatar_url" "text", "author_primary_sport" "text", "total_count" bigint, "has_more" boolean)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  offset_val int := GREATEST((page - 1) * page_size, 0);
  sort_col text := CASE lower(sort_by)
    WHEN 'created_at' THEN 'created_at'
    WHEN 'likes_count' THEN 'likes_count'
    WHEN 'comments_count' THEN 'comments_count'
    WHEN 'shares_count' THEN 'shares_count'
    ELSE 'created_at'
  END;
  sort_dir text := CASE lower(sort_order)
    WHEN 'asc' THEN 'asc'
    ELSE 'desc'
  END;
  current_primary_sport text := (
    SELECT users.sports_categories->>0
    FROM public.users
    WHERE id = user_id_param
  );
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT *
    FROM public.v_posts_enriched v
    WHERE
      CASE
        WHEN lower(feed_filter) = 'following' THEN EXISTS (
          SELECT 1
          FROM public.user_following f
          WHERE f.follower_id = user_id_param
            AND f.following_id = v.author_id
        )
        WHEN lower(feed_filter) = 'my-sport' THEN
          COALESCE(v.author_primary_sport, '') = COALESCE(current_primary_sport, '')
        ELSE TRUE
      END
  ),
  counted AS (
    SELECT b.*,
           COUNT(*) OVER() AS total_count_all
    FROM base b
  ),
  ordered AS (
    SELECT *
    FROM counted c
    ORDER BY
      CASE WHEN sort_col = 'created_at'     AND sort_dir = 'asc'  THEN c.created_at     END ASC,
      CASE WHEN sort_col = 'created_at'     AND sort_dir = 'desc' THEN c.created_at     END DESC,
      CASE WHEN sort_col = 'likes_count'    AND sort_dir = 'asc'  THEN c.likes_count    END ASC,
      CASE WHEN sort_col = 'likes_count'    AND sort_dir = 'desc' THEN c.likes_count    END DESC,
      CASE WHEN sort_col = 'comments_count' AND sort_dir = 'asc'  THEN c.comments_count END ASC,
      CASE WHEN sort_col = 'comments_count' AND sort_dir = 'desc' THEN c.comments_count END DESC,
      CASE WHEN sort_col = 'shares_count'   AND sort_dir = 'asc'  THEN c.shares_count   END ASC,
      CASE WHEN sort_col = 'shares_count'   AND sort_dir = 'desc' THEN c.shares_count   END DESC,
      c.post_id DESC
  )
  SELECT
    o.post_id,
    o.author_id,
    o.content,
    o.media_urls,
    o.likes_count,
    o.shares_count,
    o.comments_count,
    o.created_at,
    o.updated_at,
    o.author_name::text,
    o.author_username::text,
    o.author_avatar_url::text,
    o.author_primary_sport::text,
    o.total_count_all AS total_count,
    (offset_val + page_size) < o.total_count_all AS has_more
  FROM ordered o
  OFFSET offset_val
  LIMIT page_size;
END;
$$;


ALTER FUNCTION "public"."get_home_feed"("user_id_param" "uuid", "feed_filter" "text", "page" integer, "page_size" integer, "sort_by" "text", "sort_order" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_suggested_users"("current_user_id" "uuid", "limit_param" integer DEFAULT 5, "sports_category_param" "text" DEFAULT NULL::"text", "exclude_following" boolean DEFAULT true) RETURNS TABLE("id" "uuid", "username" "text", "name" "text", "avatar_url" "text", "role" "text", "sports_categories" "jsonb", "is_verified" boolean, "bio" "text", "created_at" timestamp with time zone, "followers_count" bigint, "posts_count" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  WITH base AS (
    SELECT s.*
    FROM public.v_user_stats s
    WHERE s.id <> current_user_id
      AND (
        sports_category_param IS NULL
        OR (s.sports_categories ?| ARRAY[sports_category_param])
        OR s.sports_categories @> to_jsonb(ARRAY[sports_category_param])::jsonb
      )
  ),
  filtered AS (
    SELECT b.*
    FROM base b
    WHERE NOT (
      exclude_following
      AND EXISTS (
        SELECT 1
        FROM public.user_following f
        WHERE f.follower_id = current_user_id
          AND f.following_id = b.id
      )
    )
  )
  SELECT
    f.id,
    f.username::text,
    f.name::text,
    f.avatar_url::text,
    f.role::text,
    f.sports_categories,
    f.is_verified,
    f.bio::text,
    f.created_at,
    f.followers_count,
    f.posts_count
  FROM filtered f
  ORDER BY
    f.followers_count DESC,
    f.posts_count DESC,
    f.created_at DESC
  LIMIT GREATEST(limit_param, 1)
$$;


ALTER FUNCTION "public"."get_suggested_users"("current_user_id" "uuid", "limit_param" integer, "sports_category_param" "text", "exclude_following" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    INSERT INTO public.users (id, email, name, role, created_at, updated_at)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'name', NEW.email),
        NULL, -- Role will be set during profile completion
        NOW(),
        NOW()
    );
    
    -- Initialize user tokens with welcome bonus
    INSERT INTO public.user_tokens (user_id, balance, created_at, updated_at)
    VALUES (NEW.id, 100, NOW(), NOW());
    
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_referral_uses"("referral_code_param" character varying) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  UPDATE public.referral_codes
  SET uses_count = uses_count + 1
  WHERE code = referral_code_param AND is_active = true;
END;
$$;


ALTER FUNCTION "public"."increment_referral_uses"("referral_code_param" character varying) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spend_user_tokens"("user_id_param" "uuid", "amount_param" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    current_balance INTEGER;
BEGIN
    -- Check current balance
    SELECT tokens INTO current_balance FROM users WHERE id = user_id_param;
    
    IF current_balance < amount_param THEN
        RETURN FALSE; -- Insufficient balance
    END IF;
    
    -- Update user's token balance
    UPDATE users 
    SET tokens = tokens - amount_param,
        updated_at = NOW()
    WHERE id = user_id_param;
    
    -- Update user_tokens record
    UPDATE user_tokens 
    SET balance = balance - amount_param,
        total_spent = total_spent + amount_param,
        updated_at = NOW()
    WHERE user_id = user_id_param;
    
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$$;


ALTER FUNCTION "public"."spend_user_tokens"("user_id_param" "uuid", "amount_param" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spend_user_tokens_with_transaction"("user_id_param" "uuid", "amount_param" integer, "transaction_type_param" "text" DEFAULT 'spend'::"text", "description_param" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    current_balance INTEGER;
BEGIN
    -- Check current balance
    SELECT tokens INTO current_balance FROM users WHERE id = user_id_param;
    
    IF current_balance < amount_param THEN
        RETURN FALSE; -- Insufficient balance
    END IF;
    
    -- Update user's token balance
    UPDATE users 
    SET tokens = tokens - amount_param,
        updated_at = NOW()
    WHERE id = user_id_param;
    
    -- Update user_tokens record
    UPDATE user_tokens 
    SET balance = balance - amount_param,
        total_spent = total_spent + amount_param,
        updated_at = NOW()
    WHERE user_id = user_id_param;
    
    -- Log transaction
    INSERT INTO token_transactions (
        to_user_id,
        amount,
        type,
        description,
        created_at
    ) VALUES (
        user_id_param,
        amount_param,
        transaction_type_param,
        description_param,
        NOW()
    );
    
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RETURN FALSE;
END;
$$;


ALTER FUNCTION "public"."spend_user_tokens_with_transaction"("user_id_param" "uuid", "amount_param" integer, "transaction_type_param" "text", "description_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_login_streak"("user_id_param" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    current_streak INTEGER;
    max_streak INTEGER;
    last_login DATE;
    today DATE := CURRENT_DATE;
    new_streak INTEGER;
BEGIN
    -- Initialize if needed
    INSERT INTO public.user_levels (user_id, login_streak, max_login_streak, last_login_date)
    VALUES (user_id_param, 0, 0, NULL)
    ON CONFLICT (user_id) DO NOTHING;
    
    SELECT login_streak, max_login_streak, last_login_date
    INTO current_streak, max_streak, last_login
    FROM public.user_levels
    WHERE user_id = user_id_param;
    
    -- If already logged in today, return current streak
    IF last_login = today THEN
        RETURN current_streak;
    END IF;
    
    -- If logged in yesterday, increment streak
    IF last_login = today - INTERVAL '1 day' THEN
        new_streak := current_streak + 1;
    ELSIF last_login IS NULL OR last_login < today - INTERVAL '1 day' THEN
        -- Reset streak if more than 1 day gap
        new_streak := 1;
    ELSE
        new_streak := current_streak;
    END IF;
    
    -- Update max streak if needed
    IF new_streak > max_streak THEN
        max_streak := new_streak;
    END IF;
    
    -- Update user_levels
    UPDATE public.user_levels
    SET
        login_streak = new_streak,
        max_login_streak = max_streak,
        last_login_date = today,
        updated_at = NOW()
    WHERE user_id = user_id_param;
    
    RETURN new_streak;
END;
$$;


ALTER FUNCTION "public"."update_login_streak"("user_id_param" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_quest_progress"("user_id_param" "uuid", "quest_type_param" "text", "progress_amount" integer DEFAULT 1) RETURNS TABLE("completed_quests" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    quest_rec RECORD;
    user_quest_rec RECORD;
    completed_count INTEGER := 0;
    new_progress INTEGER;
BEGIN
    -- Find all active quests for user matching the quest type
    FOR user_quest_rec IN
        SELECT uq.*, q.requirement_type, q.xp_reward, q.token_reward
        FROM public.user_quests uq
        JOIN public.quests q ON q.id = uq.quest_id
        WHERE uq.user_id = user_id_param
            AND uq.status = 'active'
            AND (uq.expires_at IS NULL OR uq.expires_at > NOW())
            AND q.requirement_type = quest_type_param
    LOOP
        new_progress := LEAST(user_quest_rec.progress + progress_amount, user_quest_rec.target);
        
        -- Update progress
        UPDATE public.user_quests
        SET
            progress = new_progress,
            updated_at = NOW()
        WHERE id = user_quest_rec.id;
        
        -- Check if completed
        IF new_progress >= user_quest_rec.target THEN
            -- Mark as completed
            UPDATE public.user_quests
            SET
                status = 'completed',
                completed_at = NOW()
            WHERE id = user_quest_rec.id;
            
            -- Award XP and tokens
            PERFORM add_user_xp(
                user_id_param,
                user_quest_rec.xp_reward,
                'quest',
                user_quest_rec.quest_id,
                'Quest completed'
            );
            
            IF user_quest_rec.token_reward > 0 THEN
                PERFORM add_user_tokens(user_id_param, user_quest_rec.token_reward);
            END IF;
            
            -- Create notification
            INSERT INTO public.notifications (user_id, type, title, message, data, created_at)
            VALUES (
                user_id_param,
                'quest',
                'Quest Completed! ✅',
                'You completed a quest!',
                jsonb_build_object(
                    'quest_id', user_quest_rec.quest_id,
                    'xp_reward', user_quest_rec.xp_reward,
                    'token_reward', user_quest_rec.token_reward
                ),
                NOW()
            );
            
            completed_count := completed_count + 1;
        END IF;
    END LOOP;
    
    RETURN QUERY SELECT completed_count;
END;
$$;


ALTER FUNCTION "public"."update_quest_progress"("user_id_param" "uuid", "quest_type_param" "text", "progress_amount" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."achievements" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "code" character varying(50) NOT NULL,
    "name" character varying(100) NOT NULL,
    "description" "text" NOT NULL,
    "category" character varying(50) NOT NULL,
    "icon_url" "text",
    "xp_reward" integer DEFAULT 0 NOT NULL,
    "token_reward" integer DEFAULT 0 NOT NULL,
    "rarity" character varying(20) DEFAULT 'common'::character varying NOT NULL,
    "requirement_type" character varying(50) NOT NULL,
    "requirement_value" integer NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "achievements_category_check" CHECK ((("category")::"text" = ANY (ARRAY[('engagement'::character varying)::"text", ('social'::character varying)::"text", ('content'::character varying)::"text", ('milestone'::character varying)::"text", ('special'::character varying)::"text"]))),
    CONSTRAINT "achievements_rarity_check" CHECK ((("rarity")::"text" = ANY (ARRAY[('common'::character varying)::"text", ('rare'::character varying)::"text", ('epic'::character varying)::"text", ('legendary'::character varying)::"text"]))),
    CONSTRAINT "achievements_requirement_value_check" CHECK (("requirement_value" >= 0)),
    CONSTRAINT "achievements_token_reward_check" CHECK (("token_reward" >= 0)),
    CONSTRAINT "achievements_xp_reward_check" CHECK (("xp_reward" >= 0))
);


ALTER TABLE "public"."achievements" OWNER TO "postgres";


COMMENT ON TABLE "public"."achievements" IS 'Master list of all available achievements/badges';



CREATE TABLE IF NOT EXISTS "public"."comments" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "post_id" "uuid" NOT NULL,
    "author_id" "uuid" NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "parent_id" "uuid"
);


ALTER TABLE "public"."comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversation_participants" (
    "conversation_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" character varying(10) DEFAULT 'member'::character varying,
    "joined_at" timestamp with time zone DEFAULT "now"(),
    "is_archived" boolean DEFAULT false,
    "archived_at" timestamp with time zone,
    CONSTRAINT "conversation_participants_role_check" CHECK ((("role")::"text" = ANY (ARRAY[('admin'::character varying)::"text", ('member'::character varying)::"text"])))
);


ALTER TABLE "public"."conversation_participants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversations" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "type" character varying(10) NOT NULL,
    "name" character varying(100),
    "description" character varying(500),
    "is_private" boolean DEFAULT false,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "last_message_at" timestamp with time zone DEFAULT "now"(),
    "last_message" "text",
    "photo_url" "text",
    CONSTRAINT "conversations_type_check" CHECK ((("type")::"text" = ANY (ARRAY[('direct'::character varying)::"text", ('group'::character varying)::"text"])))
);


ALTER TABLE "public"."conversations" OWNER TO "postgres";


COMMENT ON COLUMN "public"."conversations"."photo_url" IS 'URL of the group photo for group conversations';



CREATE TABLE IF NOT EXISTS "public"."heatmap_data" (
    "id" "uuid" NOT NULL,
    "grid_lat" double precision NOT NULL,
    "grid_lng" double precision NOT NULL,
    "activity" character varying(50) NOT NULL,
    "intensity" integer DEFAULT 1 NOT NULL,
    "total_duration" integer DEFAULT 0 NOT NULL,
    "last_activity" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."heatmap_data" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."livestreams" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" character varying(255) NOT NULL,
    "description" "text" NOT NULL,
    "youtube_url" "text" NOT NULL,
    "thumbnail_url" "text",
    "category" character varying(50) NOT NULL,
    "scheduled_time" timestamp with time zone,
    "is_live" boolean DEFAULT false,
    "is_active" boolean DEFAULT true,
    "started_at" timestamp with time zone,
    "ended_at" timestamp with time zone,
    "viewers_count" integer DEFAULT 0,
    "max_viewers" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "livestreams_category_check" CHECK ((("category")::"text" = ANY (ARRAY[('coco'::character varying)::"text", ('martial-arts'::character varying)::"text", ('calorie-fight'::character varying)::"text", ('adaptive-sports'::character varying)::"text", ('unstructured-sports'::character varying)::"text"]))),
    CONSTRAINT "livestreams_max_viewers_check" CHECK (("max_viewers" >= 0)),
    CONSTRAINT "livestreams_viewers_count_check" CHECK (("viewers_count" >= 0))
);


ALTER TABLE "public"."livestreams" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."location_checkins" (
    "id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "latitude" double precision NOT NULL,
    "longitude" double precision NOT NULL,
    "location_name" "text",
    "activity" character varying(50) NOT NULL,
    "duration" integer NOT NULL,
    "notes" "text",
    "checked_in_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."location_checkins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."memberships" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" character varying(100) NOT NULL,
    "description" "text" NOT NULL,
    "price" numeric(10,2) NOT NULL,
    "token_cost" integer NOT NULL,
    "duration" integer NOT NULL,
    "features" "jsonb" NOT NULL,
    "type" character varying(20) NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    CONSTRAINT "memberships_duration_check" CHECK (("duration" > 0)),
    CONSTRAINT "memberships_price_check" CHECK (("price" >= (0)::numeric)),
    CONSTRAINT "memberships_token_cost_check" CHECK (("token_cost" >= 0)),
    CONSTRAINT "memberships_type_check" CHECK ((("type")::"text" = ANY (ARRAY[('basic'::character varying)::"text", ('premium'::character varying)::"text", ('vip'::character varying)::"text"])))
);


ALTER TABLE "public"."memberships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_reactions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "message_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "emoji" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."message_reactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_reads" (
    "message_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "read_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."message_reads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "sender_id" "uuid" NOT NULL,
    "content" "text" NOT NULL,
    "type" character varying(10) DEFAULT 'text'::character varying,
    "media_url" "text",
    "reply_to_id" "uuid",
    "is_edited" boolean DEFAULT false,
    "is_deleted" boolean DEFAULT false,
    "edited_at" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "messages_type_check" CHECK ((("type")::"text" = ANY (ARRAY[('text'::character varying)::"text", ('image'::character varying)::"text", ('video'::character varying)::"text", ('audio'::character varying)::"text", ('file'::character varying)::"text", ('system'::character varying)::"text"])))
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_preferences" (
    "user_id" "uuid" NOT NULL,
    "email_notifications" boolean DEFAULT true,
    "push_notifications" boolean DEFAULT true,
    "likes" boolean DEFAULT true,
    "comments" boolean DEFAULT true,
    "follows" boolean DEFAULT true,
    "messages" boolean DEFAULT true,
    "posts" boolean DEFAULT true,
    "shares" boolean DEFAULT true,
    "mentions" boolean DEFAULT true,
    "system" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."notification_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "type" character varying(50) NOT NULL,
    "title" character varying(255) NOT NULL,
    "message" "text" NOT NULL,
    "data" "jsonb" DEFAULT '{}'::"jsonb",
    "is_read" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "read_at" timestamp with time zone,
    "from_user_id" "uuid"
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."post_likes" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "post_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."post_likes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."post_shares" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "post_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."post_shares" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."posts" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "author_id" "uuid" NOT NULL,
    "content" "text" NOT NULL,
    "media_urls" "jsonb" DEFAULT '[]'::"jsonb",
    "likes_count" integer DEFAULT 0,
    "shares_count" integer DEFAULT 0,
    "comments_count" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."posts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."quests" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "code" character varying(50) NOT NULL,
    "title" character varying(200) NOT NULL,
    "description" "text" NOT NULL,
    "quest_type" character varying(20) NOT NULL,
    "category" character varying(50) NOT NULL,
    "requirement_type" character varying(50) NOT NULL,
    "requirement_value" integer NOT NULL,
    "xp_reward" integer DEFAULT 0 NOT NULL,
    "token_reward" integer DEFAULT 0 NOT NULL,
    "duration_type" character varying(20) NOT NULL,
    "is_recurring" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "quests_duration_type_check" CHECK ((("duration_type")::"text" = ANY (ARRAY[('daily'::character varying)::"text", ('weekly'::character varying)::"text", ('monthly'::character varying)::"text", ('permanent'::character varying)::"text"]))),
    CONSTRAINT "quests_quest_type_check" CHECK ((("quest_type")::"text" = ANY (ARRAY[('daily'::character varying)::"text", ('weekly'::character varying)::"text", ('special'::character varying)::"text"]))),
    CONSTRAINT "quests_requirement_value_check" CHECK (("requirement_value" > 0)),
    CONSTRAINT "quests_token_reward_check" CHECK (("token_reward" >= 0)),
    CONSTRAINT "quests_xp_reward_check" CHECK (("xp_reward" >= 0))
);


ALTER TABLE "public"."quests" OWNER TO "postgres";


COMMENT ON TABLE "public"."quests" IS 'Master list of daily/weekly/special quests/challenges';



CREATE TABLE IF NOT EXISTS "public"."referral_codes" (
    "code" character varying(20) NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "uses_count" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    CONSTRAINT "referral_codes_uses_count_check" CHECK (("uses_count" >= 0))
);


ALTER TABLE "public"."referral_codes" OWNER TO "postgres";


COMMENT ON TABLE "public"."referral_codes" IS 'Stores unique referral codes for each user to track referrals';



COMMENT ON COLUMN "public"."referral_codes"."code" IS 'Unique referral code (e.g., SPORT12345678)';



COMMENT ON COLUMN "public"."referral_codes"."uses_count" IS 'Number of times this referral code has been successfully used';



CREATE TABLE IF NOT EXISTS "public"."safe_location_verifications" (
    "location_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."safe_location_verifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."safe_locations" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" character varying(200) NOT NULL,
    "description" "text",
    "latitude" double precision NOT NULL,
    "longitude" double precision NOT NULL,
    "address" character varying(300),
    "category" character varying(50) NOT NULL,
    "amenities" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "safety_features" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "operating_hours" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "contact_info" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "image_urls" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "is_verified" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "verifications_count" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."safe_locations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."token_transactions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "from_user_id" "uuid",
    "to_user_id" "uuid",
    "amount" integer NOT NULL,
    "type" character varying(20) NOT NULL,
    "description" "text",
    "post_id" "uuid",
    "comment_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "token_transactions_amount_check" CHECK (("amount" > 0)),
    CONSTRAINT "token_transactions_type_check" CHECK ((("type")::"text" = ANY ((ARRAY['earned'::character varying, 'spent'::character varying, 'transfer'::character varying, 'admin_award'::character varying, 'referral'::character varying, 'referral_signup'::character varying, 'purchased'::character varying])::"text"[])))
);


ALTER TABLE "public"."token_transactions" OWNER TO "postgres";


COMMENT ON COLUMN "public"."token_transactions"."type" IS 'Transaction type: earned (tokens earned), spent (tokens spent), transfer (P2P transfer), admin_award (admin bonus), referral (referrer reward), referral_signup (new user referral bonus), purchased (bought with real money)';



CREATE TABLE IF NOT EXISTS "public"."uploads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "filename" character varying(255) NOT NULL,
    "cloudinary_public_id" character varying(255) NOT NULL,
    "cloudinary_url" "text" NOT NULL,
    "file_type" character varying(20) NOT NULL,
    "file_size" bigint NOT NULL,
    "mime_type" character varying(100) NOT NULL,
    "folder" character varying(100) DEFAULT 'general'::character varying,
    "tags" "jsonb" DEFAULT '[]'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "uploads_file_size_check" CHECK (("file_size" > 0)),
    CONSTRAINT "uploads_file_type_check" CHECK ((("file_type")::"text" = ANY ((ARRAY['image'::character varying, 'video'::character varying, 'audio'::character varying, 'document'::character varying])::"text"[])))
);


ALTER TABLE "public"."uploads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_achievements" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "achievement_id" "uuid" NOT NULL,
    "unlocked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "progress" integer DEFAULT 0 NOT NULL,
    "is_new" boolean DEFAULT true NOT NULL,
    CONSTRAINT "user_achievements_progress_check" CHECK (("progress" >= 0))
);


ALTER TABLE "public"."user_achievements" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_achievements" IS 'Tracks which achievements users have unlocked';



CREATE TABLE IF NOT EXISTS "public"."user_blocks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "blocker_id" "uuid" NOT NULL,
    "blocked_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_blocks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_following" (
    "follower_id" "uuid" NOT NULL,
    "following_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "user_following_check" CHECK (("follower_id" <> "following_id"))
);


ALTER TABLE "public"."user_following" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_levels" (
    "user_id" "uuid" NOT NULL,
    "level" integer DEFAULT 1 NOT NULL,
    "current_xp" integer DEFAULT 0 NOT NULL,
    "total_xp" integer DEFAULT 0 NOT NULL,
    "xp_to_next_level" integer DEFAULT 100 NOT NULL,
    "login_streak" integer DEFAULT 0 NOT NULL,
    "max_login_streak" integer DEFAULT 0 NOT NULL,
    "last_login_date" "date",
    "activity_streak" integer DEFAULT 0 NOT NULL,
    "max_activity_streak" integer DEFAULT 0 NOT NULL,
    "last_activity_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_levels_activity_streak_check" CHECK (("activity_streak" >= 0)),
    CONSTRAINT "user_levels_current_xp_check" CHECK (("current_xp" >= 0)),
    CONSTRAINT "user_levels_level_check" CHECK (("level" >= 1)),
    CONSTRAINT "user_levels_login_streak_check" CHECK (("login_streak" >= 0)),
    CONSTRAINT "user_levels_total_xp_check" CHECK (("total_xp" >= 0))
);


ALTER TABLE "public"."user_levels" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_levels" IS 'Tracks user XP, levels, and streaks for gamification';



CREATE TABLE IF NOT EXISTS "public"."user_memberships" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "membership_id" "uuid" NOT NULL,
    "payment_method" character varying(20) NOT NULL,
    "stripe_payment_intent_id" character varying(255),
    "amount_paid" numeric(10,2) DEFAULT 0,
    "tokens_paid" integer DEFAULT 0,
    "purchased_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone NOT NULL,
    "is_active" boolean DEFAULT true,
    "cancelled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "user_memberships_amount_paid_check" CHECK (("amount_paid" >= (0)::numeric)),
    CONSTRAINT "user_memberships_payment_method_check" CHECK ((("payment_method")::"text" = ANY (ARRAY[('tokens'::character varying)::"text", ('stripe'::character varying)::"text"]))),
    CONSTRAINT "user_memberships_tokens_paid_check" CHECK (("tokens_paid" >= 0))
);


ALTER TABLE "public"."user_memberships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_quests" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "quest_id" "uuid" NOT NULL,
    "progress" integer DEFAULT 0 NOT NULL,
    "target" integer NOT NULL,
    "status" character varying(20) DEFAULT 'active'::character varying NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "xp_earned" integer DEFAULT 0 NOT NULL,
    "tokens_earned" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_quests_progress_check" CHECK (("progress" >= 0)),
    CONSTRAINT "user_quests_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('active'::character varying)::"text", ('completed'::character varying)::"text", ('expired'::character varying)::"text", ('claimed'::character varying)::"text"]))),
    CONSTRAINT "user_quests_target_check" CHECK (("target" > 0))
);


ALTER TABLE "public"."user_quests" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_quests" IS 'Tracks user progress on individual quests';



CREATE TABLE IF NOT EXISTS "public"."user_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reporter_id" "uuid" NOT NULL,
    "reported_id" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'pending'::"text",
    "admin_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "user_reports_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'reviewed'::"text", 'resolved'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "public"."user_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_tokens" (
    "user_id" "uuid" NOT NULL,
    "balance" integer DEFAULT 100,
    "total_earned" integer DEFAULT 100,
    "total_spent" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "user_tokens_balance_check" CHECK (("balance" >= 0)),
    CONSTRAINT "user_tokens_total_earned_check" CHECK (("total_earned" >= 0)),
    CONSTRAINT "user_tokens_total_spent_check" CHECK (("total_spent" >= 0))
);


ALTER TABLE "public"."user_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "email" character varying(255) NOT NULL,
    "name" character varying(50) NOT NULL,
    "username" character varying(50),
    "avatar_url" "text",
    "role" character varying(20),
    "gender" character varying(20),
    "date_of_birth" "date",
    "location" character varying(100),
    "bio" character varying(500),
    "sports_categories" "jsonb" DEFAULT '[]'::"jsonb",
    "accessibility_needs" "jsonb" DEFAULT '[]'::"jsonb",
    "emergency_contact" "jsonb",
    "sport_roles" "jsonb" DEFAULT '[]'::"jsonb",
    "is_verified" boolean DEFAULT false,
    "is_banned" boolean DEFAULT false,
    "is_private" boolean DEFAULT false,
    "allow_location_sharing" boolean DEFAULT true,
    "push_notifications" boolean DEFAULT true,
    "email_notifications" boolean DEFAULT true,
    "privacy_mode" boolean DEFAULT false,
    "dark_mode" boolean DEFAULT false,
    "tokens" integer DEFAULT 100,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "last_login" timestamp with time zone,
    "last_active_at" timestamp with time zone DEFAULT "now"(),
    "phone" character varying(20),
    CONSTRAINT "users_gender_check" CHECK ((("gender")::"text" = ANY ((ARRAY['male'::character varying, 'female'::character varying, 'other'::character varying, 'prefer-not-to-say'::character varying])::"text"[]))),
    CONSTRAINT "users_name_check" CHECK (("length"(("name")::"text") >= 2)),
    CONSTRAINT "users_role_check" CHECK ((("role")::"text" = ANY ((ARRAY['user'::character varying, 'admin'::character varying, 'moderator'::character varying, 'coach'::character varying, 'fan'::character varying, 'aspirant'::character varying, 'administrator'::character varying])::"text"[]))),
    CONSTRAINT "users_tokens_check" CHECK (("tokens" >= 0)),
    CONSTRAINT "users_username_check" CHECK (((("username")::"text" ~ '^[a-zA-Z0-9_]+$'::"text") AND ("length"(("username")::"text") >= 3)))
);


ALTER TABLE "public"."users" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_posts_enriched" AS
 SELECT "p"."id" AS "post_id",
    "p"."author_id",
    "p"."content",
    "p"."media_urls",
    "p"."likes_count",
    "p"."shares_count",
    "p"."comments_count",
    "p"."created_at",
    "p"."updated_at",
    "u"."name" AS "author_name",
    "u"."username" AS "author_username",
    "u"."avatar_url" AS "author_avatar_url",
    COALESCE(("u"."sports_categories" ->> 0), NULL::"text") AS "author_primary_sport"
   FROM ("public"."posts" "p"
     JOIN "public"."users" "u" ON (("u"."id" = "p"."author_id")))
  WHERE (("u"."username" IS NOT NULL) AND ("u"."role" IS NOT NULL));


ALTER VIEW "public"."v_posts_enriched" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_posts_enriched" IS 'Enriched posts view with author details - filters out posts from users with incomplete profiles';



CREATE OR REPLACE VIEW "public"."v_user_stats" AS
 SELECT "u"."id",
    "u"."username",
    "u"."name",
    "u"."avatar_url",
    "u"."role",
    "u"."sports_categories",
    "u"."is_verified",
    "u"."bio",
    "u"."created_at",
    COALESCE("fc"."followers_count", (0)::bigint) AS "followers_count",
    COALESCE("pc"."posts_count", (0)::bigint) AS "posts_count"
   FROM (("public"."users" "u"
     LEFT JOIN ( SELECT "user_following"."following_id" AS "user_id",
            "count"(*) AS "followers_count"
           FROM "public"."user_following"
          GROUP BY "user_following"."following_id") "fc" ON (("fc"."user_id" = "u"."id")))
     LEFT JOIN ( SELECT "posts"."author_id" AS "user_id",
            "count"(*) AS "posts_count"
           FROM "public"."posts"
          GROUP BY "posts"."author_id") "pc" ON (("pc"."user_id" = "u"."id")));


ALTER VIEW "public"."v_user_stats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."verification_documents" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "file_url" "text" NOT NULL,
    "file_name" "text" NOT NULL,
    "document_type" character varying(50) NOT NULL,
    "status" character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    "comments" "text",
    "uploaded_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "verification_documents_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying])::"text"[])))
);


ALTER TABLE "public"."verification_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."verification_requests" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" character varying(20) NOT NULL,
    "status" character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    "notes" "text",
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "verification_requests_role_check" CHECK ((("role")::"text" = ANY ((ARRAY['aspirant'::character varying, 'coach'::character varying])::"text"[]))),
    CONSTRAINT "verification_requests_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying])::"text"[])))
);


ALTER TABLE "public"."verification_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."video_likes" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "video_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."video_likes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."video_views" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "video_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."video_views" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."videos" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "title" character varying(255) NOT NULL,
    "description" "text" NOT NULL,
    "thumbnail_url" "text" NOT NULL,
    "video_url" "text" NOT NULL,
    "duration" integer NOT NULL,
    "coach_id" "uuid" NOT NULL,
    "category" character varying(50) NOT NULL,
    "difficulty" character varying(20) NOT NULL,
    "type" character varying(20) DEFAULT 'free'::character varying,
    "token_cost" integer DEFAULT 0,
    "tags" "jsonb" DEFAULT '[]'::"jsonb",
    "views_count" integer DEFAULT 0,
    "likes_count" integer DEFAULT 0,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "videos_category_check" CHECK ((("category")::"text" = ANY (ARRAY[('coco'::character varying)::"text", ('martial-arts'::character varying)::"text", ('calorie-fight'::character varying)::"text", ('adaptive-sports'::character varying)::"text", ('unstructured-sports'::character varying)::"text"]))),
    CONSTRAINT "videos_difficulty_check" CHECK ((("difficulty")::"text" = ANY (ARRAY[('beginner'::character varying)::"text", ('intermediate'::character varying)::"text", ('advanced'::character varying)::"text"]))),
    CONSTRAINT "videos_duration_check" CHECK (("duration" > 0)),
    CONSTRAINT "videos_likes_count_check" CHECK (("likes_count" >= 0)),
    CONSTRAINT "videos_token_cost_check" CHECK (("token_cost" >= 0)),
    CONSTRAINT "videos_type_check" CHECK ((("type")::"text" = ANY (ARRAY[('free'::character varying)::"text", ('premium'::character varying)::"text"]))),
    CONSTRAINT "videos_views_count_check" CHECK (("views_count" >= 0))
);


ALTER TABLE "public"."videos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."xp_transactions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "amount" integer NOT NULL,
    "source_type" character varying(50) NOT NULL,
    "source_id" "uuid",
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "xp_transactions_amount_check" CHECK (("amount" > 0))
);


ALTER TABLE "public"."xp_transactions" OWNER TO "postgres";


COMMENT ON TABLE "public"."xp_transactions" IS 'Tracks all XP earned by users from various sources';



ALTER TABLE ONLY "public"."achievements"
    ADD CONSTRAINT "achievements_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."achievements"
    ADD CONSTRAINT "achievements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversation_participants"
    ADD CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("conversation_id", "user_id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."heatmap_data"
    ADD CONSTRAINT "heatmap_data_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."livestreams"
    ADD CONSTRAINT "livestreams_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."location_checkins"
    ADD CONSTRAINT "location_checkins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_reads"
    ADD CONSTRAINT "message_reads_pkey" PRIMARY KEY ("message_id", "user_id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."post_likes"
    ADD CONSTRAINT "post_likes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."post_shares"
    ADD CONSTRAINT "post_shares_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."posts"
    ADD CONSTRAINT "posts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."quests"
    ADD CONSTRAINT "quests_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."quests"
    ADD CONSTRAINT "quests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."referral_codes"
    ADD CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("code");



ALTER TABLE ONLY "public"."safe_location_verifications"
    ADD CONSTRAINT "safe_location_verifications_pkey" PRIMARY KEY ("location_id", "user_id");



ALTER TABLE ONLY "public"."safe_locations"
    ADD CONSTRAINT "safe_locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."token_transactions"
    ADD CONSTRAINT "token_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."post_likes"
    ADD CONSTRAINT "uniq_post_likes_post_user" UNIQUE ("post_id", "user_id");



ALTER TABLE ONLY "public"."post_shares"
    ADD CONSTRAINT "uniq_post_shares_post_user" UNIQUE ("post_id", "user_id");



ALTER TABLE ONLY "public"."uploads"
    ADD CONSTRAINT "uploads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_achievements"
    ADD CONSTRAINT "user_achievements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_achievements"
    ADD CONSTRAINT "user_achievements_user_achievement_unique" UNIQUE ("user_id", "achievement_id");



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_blocker_id_blocked_id_key" UNIQUE ("blocker_id", "blocked_id");



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_following"
    ADD CONSTRAINT "user_following_pkey" PRIMARY KEY ("follower_id", "following_id");



ALTER TABLE ONLY "public"."user_levels"
    ADD CONSTRAINT "user_levels_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."user_memberships"
    ADD CONSTRAINT "user_memberships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_quests"
    ADD CONSTRAINT "user_quests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_reports"
    ADD CONSTRAINT "user_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_tokens"
    ADD CONSTRAINT "user_tokens_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_username_key" UNIQUE ("username");



ALTER TABLE ONLY "public"."verification_documents"
    ADD CONSTRAINT "verification_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."verification_requests"
    ADD CONSTRAINT "verification_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."video_likes"
    ADD CONSTRAINT "video_likes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."video_likes"
    ADD CONSTRAINT "video_likes_unique" UNIQUE ("video_id", "user_id");



ALTER TABLE ONLY "public"."video_views"
    ADD CONSTRAINT "video_views_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."video_views"
    ADD CONSTRAINT "video_views_unique" UNIQUE ("video_id", "user_id");



ALTER TABLE ONLY "public"."videos"
    ADD CONSTRAINT "videos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."xp_transactions"
    ADD CONSTRAINT "xp_transactions_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_achievements_category" ON "public"."achievements" USING "btree" ("category");



CREATE INDEX "idx_achievements_is_active" ON "public"."achievements" USING "btree" ("is_active");



CREATE INDEX "idx_achievements_rarity" ON "public"."achievements" USING "btree" ("rarity");



CREATE INDEX "idx_comments_parent_id" ON "public"."comments" USING "btree" ("parent_id");



CREATE INDEX "idx_conversation_participants_archived" ON "public"."conversation_participants" USING "btree" ("is_archived");



CREATE INDEX "idx_conversation_participants_user" ON "public"."conversation_participants" USING "btree" ("user_id");



CREATE INDEX "idx_conversations_last_message_at" ON "public"."conversations" USING "btree" ("last_message_at" DESC);



CREATE INDEX "idx_heatmap_activity" ON "public"."heatmap_data" USING "btree" ("activity");



CREATE INDEX "idx_heatmap_grid" ON "public"."heatmap_data" USING "btree" ("grid_lat", "grid_lng");



CREATE INDEX "idx_heatmap_last_activity" ON "public"."heatmap_data" USING "btree" ("last_activity" DESC);



CREATE INDEX "idx_livestreams_category" ON "public"."livestreams" USING "btree" ("category");



CREATE INDEX "idx_livestreams_is_active" ON "public"."livestreams" USING "btree" ("is_active");



CREATE INDEX "idx_livestreams_is_live" ON "public"."livestreams" USING "btree" ("is_live");



CREATE INDEX "idx_livestreams_scheduled_time" ON "public"."livestreams" USING "btree" ("scheduled_time");



CREATE INDEX "idx_livestreams_user_id" ON "public"."livestreams" USING "btree" ("user_id");



CREATE INDEX "idx_location_checkins_user" ON "public"."location_checkins" USING "btree" ("user_id", "checked_in_at" DESC);



CREATE INDEX "idx_memberships_created_by" ON "public"."memberships" USING "btree" ("created_by");



CREATE INDEX "idx_memberships_is_active" ON "public"."memberships" USING "btree" ("is_active");



CREATE INDEX "idx_memberships_type" ON "public"."memberships" USING "btree" ("type");



CREATE INDEX "idx_message_reactions_message" ON "public"."message_reactions" USING "btree" ("message_id");



CREATE INDEX "idx_message_reads_user" ON "public"."message_reads" USING "btree" ("user_id");



CREATE INDEX "idx_messages_conversation_created" ON "public"."messages" USING "btree" ("conversation_id", "created_at" DESC);



CREATE INDEX "idx_messages_sender" ON "public"."messages" USING "btree" ("sender_id");



CREATE INDEX "idx_notification_preferences_user_id" ON "public"."notification_preferences" USING "btree" ("user_id");



CREATE INDEX "idx_notifications_from_user_id" ON "public"."notifications" USING "btree" ("from_user_id");



CREATE INDEX "idx_notifications_read_at" ON "public"."notifications" USING "btree" ("read_at");



CREATE INDEX "idx_post_likes_post_id" ON "public"."post_likes" USING "btree" ("post_id");



CREATE INDEX "idx_post_likes_user_id" ON "public"."post_likes" USING "btree" ("user_id");



CREATE INDEX "idx_post_shares_post_id" ON "public"."post_shares" USING "btree" ("post_id");



CREATE INDEX "idx_post_shares_user_id" ON "public"."post_shares" USING "btree" ("user_id");



CREATE INDEX "idx_posts_author_created_at" ON "public"."posts" USING "btree" ("author_id", "created_at" DESC);



CREATE INDEX "idx_posts_author_id" ON "public"."posts" USING "btree" ("author_id");



CREATE INDEX "idx_posts_created_at" ON "public"."posts" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_quests_duration_type" ON "public"."quests" USING "btree" ("duration_type");



CREATE INDEX "idx_quests_is_active" ON "public"."quests" USING "btree" ("is_active");



CREATE INDEX "idx_quests_quest_type" ON "public"."quests" USING "btree" ("quest_type");



CREATE INDEX "idx_referral_codes_active" ON "public"."referral_codes" USING "btree" ("is_active") WHERE ("is_active" = true);



CREATE INDEX "idx_referral_codes_user_id" ON "public"."referral_codes" USING "btree" ("user_id");



CREATE INDEX "idx_safe_locations_active" ON "public"."safe_locations" USING "btree" ("is_active");



CREATE INDEX "idx_safe_locations_category" ON "public"."safe_locations" USING "btree" ("category");



CREATE INDEX "idx_safe_locations_coords" ON "public"."safe_locations" USING "btree" ("latitude", "longitude");



CREATE INDEX "idx_token_transactions_created_at" ON "public"."token_transactions" USING "btree" ("created_at");



CREATE INDEX "idx_token_transactions_from_user" ON "public"."token_transactions" USING "btree" ("from_user_id");



CREATE INDEX "idx_token_transactions_to_user" ON "public"."token_transactions" USING "btree" ("to_user_id");



CREATE INDEX "idx_token_transactions_type" ON "public"."token_transactions" USING "btree" ("type");



CREATE INDEX "idx_uploads_created_at" ON "public"."uploads" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_uploads_file_type" ON "public"."uploads" USING "btree" ("file_type");



CREATE INDEX "idx_uploads_folder" ON "public"."uploads" USING "btree" ("folder");



CREATE INDEX "idx_uploads_user_id" ON "public"."uploads" USING "btree" ("user_id");



CREATE INDEX "idx_user_achievements_is_new" ON "public"."user_achievements" USING "btree" ("is_new");



CREATE INDEX "idx_user_achievements_unlocked_at" ON "public"."user_achievements" USING "btree" ("unlocked_at" DESC);



CREATE INDEX "idx_user_achievements_user_id" ON "public"."user_achievements" USING "btree" ("user_id");



CREATE INDEX "idx_user_blocks_blocked_id" ON "public"."user_blocks" USING "btree" ("blocked_id");



CREATE INDEX "idx_user_blocks_blocker_id" ON "public"."user_blocks" USING "btree" ("blocker_id");



CREATE INDEX "idx_user_following_follower" ON "public"."user_following" USING "btree" ("follower_id", "following_id");



CREATE INDEX "idx_user_following_following" ON "public"."user_following" USING "btree" ("following_id");



CREATE INDEX "idx_user_levels_level" ON "public"."user_levels" USING "btree" ("level" DESC);



CREATE INDEX "idx_user_levels_login_streak" ON "public"."user_levels" USING "btree" ("login_streak" DESC);



CREATE INDEX "idx_user_levels_total_xp" ON "public"."user_levels" USING "btree" ("total_xp" DESC);



CREATE INDEX "idx_user_memberships_expires_at" ON "public"."user_memberships" USING "btree" ("expires_at");



CREATE INDEX "idx_user_memberships_is_active" ON "public"."user_memberships" USING "btree" ("is_active");



CREATE INDEX "idx_user_memberships_membership_id" ON "public"."user_memberships" USING "btree" ("membership_id");



CREATE INDEX "idx_user_memberships_user_id" ON "public"."user_memberships" USING "btree" ("user_id");



CREATE INDEX "idx_user_quests_expires_at" ON "public"."user_quests" USING "btree" ("expires_at");



CREATE INDEX "idx_user_quests_status" ON "public"."user_quests" USING "btree" ("status");



CREATE INDEX "idx_user_quests_user_id" ON "public"."user_quests" USING "btree" ("user_id");



CREATE INDEX "idx_user_quests_user_status" ON "public"."user_quests" USING "btree" ("user_id", "status");



CREATE INDEX "idx_user_reports_reported_id" ON "public"."user_reports" USING "btree" ("reported_id");



CREATE INDEX "idx_user_reports_reporter_id" ON "public"."user_reports" USING "btree" ("reporter_id");



CREATE INDEX "idx_user_reports_status" ON "public"."user_reports" USING "btree" ("status");



CREATE INDEX "idx_users_created_at" ON "public"."users" USING "btree" ("created_at");



CREATE INDEX "idx_users_email" ON "public"."users" USING "btree" ("email");



CREATE INDEX "idx_users_is_banned" ON "public"."users" USING "btree" ("is_banned");



CREATE INDEX "idx_users_is_verified" ON "public"."users" USING "btree" ("is_verified");



CREATE INDEX "idx_users_role" ON "public"."users" USING "btree" ("role");



CREATE INDEX "idx_users_sports_categories_gin" ON "public"."users" USING "gin" ("sports_categories");



CREATE INDEX "idx_users_tokens" ON "public"."users" USING "btree" ("tokens");



CREATE INDEX "idx_users_username" ON "public"."users" USING "btree" ("username");



CREATE INDEX "idx_verification_documents_request" ON "public"."verification_documents" USING "btree" ("request_id");



CREATE INDEX "idx_verification_requests_status" ON "public"."verification_requests" USING "btree" ("status");



CREATE INDEX "idx_verification_requests_user" ON "public"."verification_requests" USING "btree" ("user_id");



CREATE INDEX "idx_video_likes_user_id" ON "public"."video_likes" USING "btree" ("user_id");



CREATE INDEX "idx_video_likes_video_id" ON "public"."video_likes" USING "btree" ("video_id");



CREATE INDEX "idx_video_views_created_at" ON "public"."video_views" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_video_views_user_id" ON "public"."video_views" USING "btree" ("user_id");



CREATE INDEX "idx_video_views_video_id" ON "public"."video_views" USING "btree" ("video_id");



CREATE INDEX "idx_videos_category" ON "public"."videos" USING "btree" ("category");



CREATE INDEX "idx_videos_coach_id" ON "public"."videos" USING "btree" ("coach_id");



CREATE INDEX "idx_videos_created_at" ON "public"."videos" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_videos_is_active" ON "public"."videos" USING "btree" ("is_active");



CREATE INDEX "idx_videos_type" ON "public"."videos" USING "btree" ("type");



CREATE INDEX "idx_xp_transactions_source_type" ON "public"."xp_transactions" USING "btree" ("source_type");



CREATE INDEX "idx_xp_transactions_user_id" ON "public"."xp_transactions" USING "btree" ("user_id", "created_at" DESC);



CREATE OR REPLACE TRIGGER "create_referral_code_on_user_creation" AFTER INSERT ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."create_user_referral_code"();



CREATE OR REPLACE TRIGGER "update_achievements_updated_at" BEFORE UPDATE ON "public"."achievements" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_livestreams_updated_at" BEFORE UPDATE ON "public"."livestreams" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_memberships_updated_at" BEFORE UPDATE ON "public"."memberships" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_messages_updated_at" BEFORE UPDATE ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_notification_preferences_updated_at" BEFORE UPDATE ON "public"."notification_preferences" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_posts_updated_at" BEFORE UPDATE ON "public"."posts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_quests_updated_at" BEFORE UPDATE ON "public"."quests" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_safe_locations_updated_at" BEFORE UPDATE ON "public"."safe_locations" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_uploads_updated_at" BEFORE UPDATE ON "public"."uploads" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_user_levels_updated_at" BEFORE UPDATE ON "public"."user_levels" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_user_memberships_updated_at" BEFORE UPDATE ON "public"."user_memberships" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_user_quests_updated_at" BEFORE UPDATE ON "public"."user_quests" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_user_tokens_updated_at" BEFORE UPDATE ON "public"."user_tokens" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_users_updated_at" BEFORE UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_verification_requests_updated_at" BEFORE UPDATE ON "public"."verification_requests" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_videos_updated_at" BEFORE UPDATE ON "public"."videos" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversation_participants"
    ADD CONSTRAINT "conversation_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversation_participants"
    ADD CONSTRAINT "conversation_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."livestreams"
    ADD CONSTRAINT "livestreams_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."location_checkins"
    ADD CONSTRAINT "location_checkins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_reads"
    ADD CONSTRAINT "message_reads_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_reads"
    ADD CONSTRAINT "message_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."post_likes"
    ADD CONSTRAINT "post_likes_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."post_likes"
    ADD CONSTRAINT "post_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."post_shares"
    ADD CONSTRAINT "post_shares_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."post_shares"
    ADD CONSTRAINT "post_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."posts"
    ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."referral_codes"
    ADD CONSTRAINT "referral_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."safe_location_verifications"
    ADD CONSTRAINT "safe_location_verifications_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."safe_locations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."safe_location_verifications"
    ADD CONSTRAINT "safe_location_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."safe_locations"
    ADD CONSTRAINT "safe_locations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."token_transactions"
    ADD CONSTRAINT "token_transactions_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."token_transactions"
    ADD CONSTRAINT "token_transactions_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."uploads"
    ADD CONSTRAINT "uploads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_achievements"
    ADD CONSTRAINT "user_achievements_achievement_id_fkey" FOREIGN KEY ("achievement_id") REFERENCES "public"."achievements"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_achievements"
    ADD CONSTRAINT "user_achievements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_following"
    ADD CONSTRAINT "user_following_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_following"
    ADD CONSTRAINT "user_following_following_id_fkey" FOREIGN KEY ("following_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_levels"
    ADD CONSTRAINT "user_levels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_memberships"
    ADD CONSTRAINT "user_memberships_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_memberships"
    ADD CONSTRAINT "user_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_quests"
    ADD CONSTRAINT "user_quests_quest_id_fkey" FOREIGN KEY ("quest_id") REFERENCES "public"."quests"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_quests"
    ADD CONSTRAINT "user_quests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_reports"
    ADD CONSTRAINT "user_reports_reported_id_fkey" FOREIGN KEY ("reported_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_reports"
    ADD CONSTRAINT "user_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_tokens"
    ADD CONSTRAINT "user_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."verification_documents"
    ADD CONSTRAINT "verification_documents_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."verification_requests"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."verification_documents"
    ADD CONSTRAINT "verification_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."verification_requests"
    ADD CONSTRAINT "verification_requests_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."verification_requests"
    ADD CONSTRAINT "verification_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."video_likes"
    ADD CONSTRAINT "video_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."video_likes"
    ADD CONSTRAINT "video_likes_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."video_views"
    ADD CONSTRAINT "video_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."video_views"
    ADD CONSTRAINT "video_views_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."videos"
    ADD CONSTRAINT "videos_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."xp_transactions"
    ADD CONSTRAINT "xp_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Admins can add participants" ON "public"."conversation_participants" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."conversation_participants" "cp"
  WHERE (("cp"."conversation_id" = "conversation_participants"."conversation_id") AND ("cp"."user_id" = "auth"."uid"()) AND (("cp"."role")::"text" = 'admin'::"text")))));



CREATE POLICY "Admins can manage achievements" ON "public"."achievements" USING ((EXISTS ( SELECT 1
   FROM "public"."users"
  WHERE (("users"."id" = "auth"."uid"()) AND (("users"."role")::"text" = ANY (ARRAY[('admin'::character varying)::"text", ('administrator'::character varying)::"text"]))))));



CREATE POLICY "Admins can manage quests" ON "public"."quests" USING ((EXISTS ( SELECT 1
   FROM "public"."users"
  WHERE (("users"."id" = "auth"."uid"()) AND (("users"."role")::"text" = ANY (ARRAY[('admin'::character varying)::"text", ('administrator'::character varying)::"text"]))))));



CREATE POLICY "Admins can update all reports" ON "public"."user_reports" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."users"
  WHERE (("users"."id" = "auth"."uid"()) AND (("users"."role")::"text" = ANY ((ARRAY['admin'::character varying, 'administrator'::character varying])::"text"[]))))));



CREATE POLICY "Admins can view all reports" ON "public"."user_reports" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."users"
  WHERE (("users"."id" = "auth"."uid"()) AND (("users"."role")::"text" = ANY ((ARRAY['admin'::character varying, 'administrator'::character varying])::"text"[]))))));



CREATE POLICY "Admins or coaches can create memberships" ON "public"."memberships" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND ((("u"."role")::"text" = 'admin'::"text") OR (("u"."role")::"text" = 'coach'::"text"))))));



CREATE POLICY "Admins or coaches can update review status" ON "public"."verification_requests" FOR UPDATE TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND (("u"."role")::"text" = ANY ((ARRAY['admin'::character varying, 'administrator'::character varying])::"text"[]))))) OR ((EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND (("u"."role")::"text" = 'coach'::"text")))) AND (("role")::"text" = 'aspirant'::"text"))));



CREATE POLICY "Admins or self can remove participant" ON "public"."conversation_participants" FOR DELETE USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."conversation_participants" "cp"
  WHERE (("cp"."conversation_id" = "conversation_participants"."conversation_id") AND ("cp"."user_id" = "auth"."uid"()) AND (("cp"."role")::"text" = 'admin'::"text"))))));



CREATE POLICY "Anyone can view active achievements" ON "public"."achievements" FOR SELECT USING (("is_active" = true));



CREATE POLICY "Anyone can view active livestreams" ON "public"."livestreams" FOR SELECT USING (("is_active" = true));



CREATE POLICY "Anyone can view active memberships" ON "public"."memberships" FOR SELECT USING (("is_active" = true));



CREATE POLICY "Anyone can view active quests" ON "public"."quests" FOR SELECT USING (("is_active" = true));



CREATE POLICY "Anyone can view active videos" ON "public"."videos" FOR SELECT USING (("is_active" = true));



CREATE POLICY "Anyone can view codes for lookup" ON "public"."referral_codes" FOR SELECT TO "authenticated", "anon" USING (("is_active" = true));



CREATE POLICY "Anyone can view comments" ON "public"."comments" FOR SELECT USING (true);



CREATE POLICY "Anyone can view likes" ON "public"."post_likes" FOR SELECT USING (true);



CREATE POLICY "Anyone can view posts" ON "public"."posts" FOR SELECT USING (true);



CREATE POLICY "Anyone can view safe locations" ON "public"."safe_locations" FOR SELECT USING (("is_active" = true));



CREATE POLICY "Anyone can view shares" ON "public"."post_shares" FOR SELECT USING (true);



CREATE POLICY "Anyone can view video likes" ON "public"."video_likes" FOR SELECT USING (true);



CREATE POLICY "Authenticated can insert safe locations" ON "public"."safe_locations" FOR INSERT WITH CHECK (("auth"."uid"() = "created_by"));



CREATE POLICY "Coaches can create livestreams" ON "public"."livestreams" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."users"
  WHERE (("users"."id" = "auth"."uid"()) AND (("users"."role")::"text" = 'coach'::"text"))))));



CREATE POLICY "Coaches can create videos" ON "public"."videos" FOR INSERT WITH CHECK ((("coach_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."users"
  WHERE (("users"."id" = "auth"."uid"()) AND (("users"."role")::"text" = 'coach'::"text"))))));



CREATE POLICY "Coaches can delete own livestreams" ON "public"."livestreams" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Coaches can delete own videos" ON "public"."videos" FOR DELETE USING (("coach_id" = "auth"."uid"()));



CREATE POLICY "Coaches can update own livestreams" ON "public"."livestreams" FOR UPDATE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Coaches can update own videos" ON "public"."videos" FOR UPDATE USING (("coach_id" = "auth"."uid"()));



CREATE POLICY "Creators can delete safe locations" ON "public"."safe_locations" FOR DELETE USING (("created_by" = "auth"."uid"()));



CREATE POLICY "Creators can manage safe locations" ON "public"."safe_locations" FOR UPDATE USING (("created_by" = "auth"."uid"()));



CREATE POLICY "Creators or admins can delete memberships" ON "public"."memberships" FOR DELETE USING ((("created_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND (("u"."role")::"text" = 'admin'::"text"))))));



CREATE POLICY "Creators or admins can update memberships" ON "public"."memberships" FOR UPDATE USING ((("created_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND (("u"."role")::"text" = 'admin'::"text"))))));



CREATE POLICY "Participants can react" ON "public"."message_reactions" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM ("public"."messages" "m"
     JOIN "public"."conversation_participants" "cp" ON (("cp"."conversation_id" = "m"."conversation_id")))
  WHERE (("m"."id" = "message_reactions"."message_id") AND ("cp"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Participants can send messages" ON "public"."messages" FOR INSERT WITH CHECK ((("sender_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."conversation_participants" "cp"
  WHERE (("cp"."conversation_id" = "messages"."conversation_id") AND ("cp"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Participants can view messages" ON "public"."messages" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."conversation_participants" "cp"
  WHERE (("cp"."conversation_id" = "messages"."conversation_id") AND ("cp"."user_id" = "auth"."uid"())))));



CREATE POLICY "Participants can view reactions" ON "public"."message_reactions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."messages" "m"
     JOIN "public"."conversation_participants" "cp" ON (("cp"."conversation_id" = "m"."conversation_id")))
  WHERE (("m"."id" = "message_reactions"."message_id") AND ("cp"."user_id" = "auth"."uid"())))));



CREATE POLICY "Participants can view reads" ON "public"."message_reads" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."messages" "m"
     JOIN "public"."conversation_participants" "cp" ON (("cp"."conversation_id" = "m"."conversation_id")))
  WHERE (("m"."id" = "message_reads"."message_id") AND ("cp"."user_id" = "auth"."uid"())))));



CREATE POLICY "Reviewers can view documents for review" ON "public"."verification_documents" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."verification_requests" "vr"
     JOIN "public"."users" "u" ON (("u"."id" = "auth"."uid"())))
  WHERE (("vr"."id" = "verification_documents"."request_id") AND ((("u"."role")::"text" = ANY ((ARRAY['admin'::character varying, 'administrator'::character varying])::"text"[])) OR ((("u"."role")::"text" = 'coach'::"text") AND (("vr"."role")::"text" = 'aspirant'::"text")))))));



CREATE POLICY "Reviewers can view requests" ON "public"."verification_requests" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."users" "u"
  WHERE (("u"."id" = "auth"."uid"()) AND (("u"."role")::"text" = ANY ((ARRAY['admin'::character varying, 'administrator'::character varying, 'coach'::character varying])::"text"[]))))));



CREATE POLICY "Senders can edit their messages" ON "public"."messages" FOR UPDATE USING (("sender_id" = "auth"."uid"()));



CREATE POLICY "System can create user memberships" ON "public"."user_memberships" FOR INSERT WITH CHECK (true);



CREATE POLICY "System can insert XP transactions" ON "public"."xp_transactions" FOR INSERT WITH CHECK (true);



CREATE POLICY "System can insert achievements" ON "public"."user_achievements" FOR INSERT WITH CHECK (true);



CREATE POLICY "System can insert levels" ON "public"."user_levels" FOR INSERT WITH CHECK (true);



CREATE POLICY "System can insert notifications" ON "public"."notifications" FOR INSERT WITH CHECK (true);



CREATE POLICY "System can insert referral codes" ON "public"."referral_codes" FOR INSERT TO "authenticated", "service_role" WITH CHECK (true);



CREATE POLICY "System can insert transactions" ON "public"."token_transactions" FOR INSERT WITH CHECK (true);



CREATE POLICY "System can insert user tokens" ON "public"."user_tokens" FOR INSERT WITH CHECK (true);



CREATE POLICY "System can manage user quests" ON "public"."user_quests" WITH CHECK (true);



CREATE POLICY "System can update levels" ON "public"."user_levels" FOR UPDATE USING (true);



CREATE POLICY "Users can create comments" ON "public"."comments" FOR INSERT WITH CHECK (("auth"."uid"() = "author_id"));



CREATE POLICY "Users can create conversations" ON "public"."conversations" FOR INSERT WITH CHECK (("created_by" = "auth"."uid"()));



CREATE POLICY "Users can create own verification request" ON "public"."verification_requests" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can create posts" ON "public"."posts" FOR INSERT WITH CHECK (("auth"."uid"() = "author_id"));



CREATE POLICY "Users can create their own blocks" ON "public"."user_blocks" FOR INSERT WITH CHECK (("blocker_id" = "auth"."uid"()));



CREATE POLICY "Users can create their own reports" ON "public"."user_reports" FOR INSERT WITH CHECK (("reporter_id" = "auth"."uid"()));



CREATE POLICY "Users can create uploads" ON "public"."uploads" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can delete own comments" ON "public"."comments" FOR DELETE USING (("auth"."uid"() = "author_id"));



CREATE POLICY "Users can delete own posts" ON "public"."posts" FOR DELETE USING (("auth"."uid"() = "author_id"));



CREATE POLICY "Users can delete own uploads" ON "public"."uploads" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can delete their own blocks" ON "public"."user_blocks" FOR DELETE USING (("blocker_id" = "auth"."uid"()));



CREATE POLICY "Users can delete their verification" ON "public"."safe_location_verifications" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own notification preferences" ON "public"."notification_preferences" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own profile" ON "public"."users" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can insert their check-ins" ON "public"."location_checkins" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their verification" ON "public"."safe_location_verifications" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can like posts" ON "public"."post_likes" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can like videos" ON "public"."video_likes" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage own follows" ON "public"."user_following" USING (("auth"."uid"() = "follower_id"));



CREATE POLICY "Users can mark messages read" ON "public"."message_reads" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can remove own reactions" ON "public"."message_reactions" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can share posts" ON "public"."post_shares" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can unlike own likes" ON "public"."post_likes" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can unlike own likes" ON "public"."video_likes" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can unshare own shares" ON "public"."post_shares" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update conversations they admin" ON "public"."conversations" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."conversation_participants" "cp"
  WHERE (("cp"."conversation_id" = "conversations"."id") AND ("cp"."user_id" = "auth"."uid"()) AND (("cp"."role")::"text" = 'admin'::"text")))));



CREATE POLICY "Users can update own achievements" ON "public"."user_achievements" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own comments" ON "public"."comments" FOR UPDATE USING (("auth"."uid"() = "author_id"));



CREATE POLICY "Users can update own memberships" ON "public"."user_memberships" FOR UPDATE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can update own notification preferences" ON "public"."notification_preferences" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own notifications" ON "public"."notifications" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own posts" ON "public"."posts" FOR UPDATE USING (("auth"."uid"() = "author_id"));



CREATE POLICY "Users can update own profile" ON "public"."users" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can update own referral codes" ON "public"."referral_codes" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own tokens" ON "public"."user_tokens" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own uploads" ON "public"."uploads" FOR UPDATE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can upload own documents" ON "public"."verification_documents" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view all achievements" ON "public"."user_achievements" FOR SELECT USING (true);



CREATE POLICY "Users can view all follows" ON "public"."user_following" FOR SELECT USING (true);



CREATE POLICY "Users can view all levels" ON "public"."user_levels" FOR SELECT USING (true);



CREATE POLICY "Users can view all profiles" ON "public"."users" FOR SELECT USING (true);



CREATE POLICY "Users can view own XP transactions" ON "public"."xp_transactions" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own achievements" ON "public"."user_achievements" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own documents" ON "public"."verification_documents" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own level" ON "public"."user_levels" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own memberships" ON "public"."user_memberships" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can view own notification preferences" ON "public"."notification_preferences" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own notifications" ON "public"."notifications" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own quests" ON "public"."user_quests" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own referral codes" ON "public"."referral_codes" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own requests" ON "public"."verification_requests" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own tokens" ON "public"."user_tokens" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own transactions" ON "public"."token_transactions" FOR SELECT USING ((("auth"."uid"() = "from_user_id") OR ("auth"."uid"() = "to_user_id")));



CREATE POLICY "Users can view own uploads" ON "public"."uploads" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can view participants of their conversations" ON "public"."conversation_participants" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."conversation_participants" "self"
  WHERE (("self"."conversation_id" = "self"."conversation_id") AND ("self"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view their check-ins" ON "public"."location_checkins" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their conversations" ON "public"."conversations" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."conversation_participants" "cp"
  WHERE (("cp"."conversation_id" = "conversations"."id") AND ("cp"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view their own blocks" ON "public"."user_blocks" FOR SELECT USING (("blocker_id" = "auth"."uid"()));



CREATE POLICY "Users can view their own reports" ON "public"."user_reports" FOR SELECT USING (("reporter_id" = "auth"."uid"()));



CREATE POLICY "Users can view their verification" ON "public"."safe_location_verifications" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."achievements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."comments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversation_participants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."heatmap_data" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."livestreams" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."location_checkins" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."memberships" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_reactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_reads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."post_likes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."post_shares" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."posts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."quests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."referral_codes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."safe_location_verifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."safe_locations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."token_transactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."uploads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_achievements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_blocks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_following" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_levels" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_memberships" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_quests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."verification_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."verification_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."video_likes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."videos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."xp_transactions" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

























































































































































GRANT ALL ON FUNCTION "public"."add_user_tokens"("user_id_param" "uuid", "amount_param" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."add_user_tokens"("user_id_param" "uuid", "amount_param" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."add_user_tokens"("user_id_param" "uuid", "amount_param" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."add_user_xp"("user_id_param" "uuid", "xp_amount" integer, "source_type_param" "text", "source_id_param" "uuid", "description_param" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."add_user_xp"("user_id_param" "uuid", "xp_amount" integer, "source_type_param" "text", "source_id_param" "uuid", "description_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."add_user_xp"("user_id_param" "uuid", "xp_amount" integer, "source_type_param" "text", "source_id_param" "uuid", "description_param" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."calculate_xp_for_level"("level" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."calculate_xp_for_level"("level" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."calculate_xp_for_level"("level" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."check_and_award_achievements"("user_id_param" "uuid", "achievement_type_param" "text", "current_value_param" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."check_and_award_achievements"("user_id_param" "uuid", "achievement_type_param" "text", "current_value_param" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_and_award_achievements"("user_id_param" "uuid", "achievement_type_param" "text", "current_value_param" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."create_user_referral_code"() TO "anon";
GRANT ALL ON FUNCTION "public"."create_user_referral_code"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_user_referral_code"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_home_feed"("user_id_param" "uuid", "feed_filter" "text", "page" integer, "page_size" integer, "sort_by" "text", "sort_order" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_home_feed"("user_id_param" "uuid", "feed_filter" "text", "page" integer, "page_size" integer, "sort_by" "text", "sort_order" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_home_feed"("user_id_param" "uuid", "feed_filter" "text", "page" integer, "page_size" integer, "sort_by" "text", "sort_order" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_suggested_users"("current_user_id" "uuid", "limit_param" integer, "sports_category_param" "text", "exclude_following" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."get_suggested_users"("current_user_id" "uuid", "limit_param" integer, "sports_category_param" "text", "exclude_following" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_suggested_users"("current_user_id" "uuid", "limit_param" integer, "sports_category_param" "text", "exclude_following" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_referral_uses"("referral_code_param" character varying) TO "anon";
GRANT ALL ON FUNCTION "public"."increment_referral_uses"("referral_code_param" character varying) TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_referral_uses"("referral_code_param" character varying) TO "service_role";



GRANT ALL ON FUNCTION "public"."spend_user_tokens"("user_id_param" "uuid", "amount_param" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."spend_user_tokens"("user_id_param" "uuid", "amount_param" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."spend_user_tokens"("user_id_param" "uuid", "amount_param" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."spend_user_tokens_with_transaction"("user_id_param" "uuid", "amount_param" integer, "transaction_type_param" "text", "description_param" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."spend_user_tokens_with_transaction"("user_id_param" "uuid", "amount_param" integer, "transaction_type_param" "text", "description_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spend_user_tokens_with_transaction"("user_id_param" "uuid", "amount_param" integer, "transaction_type_param" "text", "description_param" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_login_streak"("user_id_param" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."update_login_streak"("user_id_param" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_login_streak"("user_id_param" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_quest_progress"("user_id_param" "uuid", "quest_type_param" "text", "progress_amount" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."update_quest_progress"("user_id_param" "uuid", "quest_type_param" "text", "progress_amount" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_quest_progress"("user_id_param" "uuid", "quest_type_param" "text", "progress_amount" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";


















GRANT ALL ON TABLE "public"."achievements" TO "anon";
GRANT ALL ON TABLE "public"."achievements" TO "authenticated";
GRANT ALL ON TABLE "public"."achievements" TO "service_role";



GRANT ALL ON TABLE "public"."comments" TO "anon";
GRANT ALL ON TABLE "public"."comments" TO "authenticated";
GRANT ALL ON TABLE "public"."comments" TO "service_role";



GRANT ALL ON TABLE "public"."conversation_participants" TO "anon";
GRANT ALL ON TABLE "public"."conversation_participants" TO "authenticated";
GRANT ALL ON TABLE "public"."conversation_participants" TO "service_role";



GRANT ALL ON TABLE "public"."conversations" TO "anon";
GRANT ALL ON TABLE "public"."conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."conversations" TO "service_role";



GRANT ALL ON TABLE "public"."heatmap_data" TO "anon";
GRANT ALL ON TABLE "public"."heatmap_data" TO "authenticated";
GRANT ALL ON TABLE "public"."heatmap_data" TO "service_role";



GRANT ALL ON TABLE "public"."livestreams" TO "anon";
GRANT ALL ON TABLE "public"."livestreams" TO "authenticated";
GRANT ALL ON TABLE "public"."livestreams" TO "service_role";



GRANT ALL ON TABLE "public"."location_checkins" TO "anon";
GRANT ALL ON TABLE "public"."location_checkins" TO "authenticated";
GRANT ALL ON TABLE "public"."location_checkins" TO "service_role";



GRANT ALL ON TABLE "public"."memberships" TO "anon";
GRANT ALL ON TABLE "public"."memberships" TO "authenticated";
GRANT ALL ON TABLE "public"."memberships" TO "service_role";



GRANT ALL ON TABLE "public"."message_reactions" TO "anon";
GRANT ALL ON TABLE "public"."message_reactions" TO "authenticated";
GRANT ALL ON TABLE "public"."message_reactions" TO "service_role";



GRANT ALL ON TABLE "public"."message_reads" TO "anon";
GRANT ALL ON TABLE "public"."message_reads" TO "authenticated";
GRANT ALL ON TABLE "public"."message_reads" TO "service_role";



GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";



GRANT ALL ON TABLE "public"."notification_preferences" TO "anon";
GRANT ALL ON TABLE "public"."notification_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."post_likes" TO "anon";
GRANT ALL ON TABLE "public"."post_likes" TO "authenticated";
GRANT ALL ON TABLE "public"."post_likes" TO "service_role";



GRANT ALL ON TABLE "public"."post_shares" TO "anon";
GRANT ALL ON TABLE "public"."post_shares" TO "authenticated";
GRANT ALL ON TABLE "public"."post_shares" TO "service_role";



GRANT ALL ON TABLE "public"."posts" TO "anon";
GRANT ALL ON TABLE "public"."posts" TO "authenticated";
GRANT ALL ON TABLE "public"."posts" TO "service_role";



GRANT ALL ON TABLE "public"."quests" TO "anon";
GRANT ALL ON TABLE "public"."quests" TO "authenticated";
GRANT ALL ON TABLE "public"."quests" TO "service_role";



GRANT ALL ON TABLE "public"."referral_codes" TO "anon";
GRANT ALL ON TABLE "public"."referral_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."referral_codes" TO "service_role";



GRANT ALL ON TABLE "public"."safe_location_verifications" TO "anon";
GRANT ALL ON TABLE "public"."safe_location_verifications" TO "authenticated";
GRANT ALL ON TABLE "public"."safe_location_verifications" TO "service_role";



GRANT ALL ON TABLE "public"."safe_locations" TO "anon";
GRANT ALL ON TABLE "public"."safe_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."safe_locations" TO "service_role";



GRANT ALL ON TABLE "public"."token_transactions" TO "anon";
GRANT ALL ON TABLE "public"."token_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."token_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."uploads" TO "anon";
GRANT ALL ON TABLE "public"."uploads" TO "authenticated";
GRANT ALL ON TABLE "public"."uploads" TO "service_role";



GRANT ALL ON TABLE "public"."user_achievements" TO "anon";
GRANT ALL ON TABLE "public"."user_achievements" TO "authenticated";
GRANT ALL ON TABLE "public"."user_achievements" TO "service_role";



GRANT ALL ON TABLE "public"."user_blocks" TO "anon";
GRANT ALL ON TABLE "public"."user_blocks" TO "authenticated";
GRANT ALL ON TABLE "public"."user_blocks" TO "service_role";



GRANT ALL ON TABLE "public"."user_following" TO "anon";
GRANT ALL ON TABLE "public"."user_following" TO "authenticated";
GRANT ALL ON TABLE "public"."user_following" TO "service_role";



GRANT ALL ON TABLE "public"."user_levels" TO "anon";
GRANT ALL ON TABLE "public"."user_levels" TO "authenticated";
GRANT ALL ON TABLE "public"."user_levels" TO "service_role";



GRANT ALL ON TABLE "public"."user_memberships" TO "anon";
GRANT ALL ON TABLE "public"."user_memberships" TO "authenticated";
GRANT ALL ON TABLE "public"."user_memberships" TO "service_role";



GRANT ALL ON TABLE "public"."user_quests" TO "anon";
GRANT ALL ON TABLE "public"."user_quests" TO "authenticated";
GRANT ALL ON TABLE "public"."user_quests" TO "service_role";



GRANT ALL ON TABLE "public"."user_reports" TO "anon";
GRANT ALL ON TABLE "public"."user_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."user_reports" TO "service_role";



GRANT ALL ON TABLE "public"."user_tokens" TO "anon";
GRANT ALL ON TABLE "public"."user_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."user_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";



GRANT ALL ON TABLE "public"."v_posts_enriched" TO "anon";
GRANT ALL ON TABLE "public"."v_posts_enriched" TO "authenticated";
GRANT ALL ON TABLE "public"."v_posts_enriched" TO "service_role";



GRANT ALL ON TABLE "public"."v_user_stats" TO "anon";
GRANT ALL ON TABLE "public"."v_user_stats" TO "authenticated";
GRANT ALL ON TABLE "public"."v_user_stats" TO "service_role";



GRANT ALL ON TABLE "public"."verification_documents" TO "anon";
GRANT ALL ON TABLE "public"."verification_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."verification_documents" TO "service_role";



GRANT ALL ON TABLE "public"."verification_requests" TO "anon";
GRANT ALL ON TABLE "public"."verification_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."verification_requests" TO "service_role";



GRANT ALL ON TABLE "public"."video_likes" TO "anon";
GRANT ALL ON TABLE "public"."video_likes" TO "authenticated";
GRANT ALL ON TABLE "public"."video_likes" TO "service_role";



GRANT ALL ON TABLE "public"."video_views" TO "anon";
GRANT ALL ON TABLE "public"."video_views" TO "authenticated";
GRANT ALL ON TABLE "public"."video_views" TO "service_role";



GRANT ALL ON TABLE "public"."videos" TO "anon";
GRANT ALL ON TABLE "public"."videos" TO "authenticated";
GRANT ALL ON TABLE "public"."videos" TO "service_role";



GRANT ALL ON TABLE "public"."xp_transactions" TO "anon";
GRANT ALL ON TABLE "public"."xp_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."xp_transactions" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































RESET ALL;
