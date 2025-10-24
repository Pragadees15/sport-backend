import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

interface Config {
  env: string;
  port: number;
  supabase: {
    url: string;
    anonKey: string;
    serviceKey: string;
  };
  cloudinary: {
    cloudName: string;
    apiKey: string;
    apiSecret: string;
  };
  cors: {
    origin: string | string[];
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  google?: {
    clientId: string;
    clientSecret: string;
  };
  redis?: {
    url: string;
  };
  email?: {
    host: string;
    port: number;
    user: string;
    pass: string;
  };
}

const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'JWT_SECRET'
];

// Optional but recommended for production
const recommendedEnvVars = [
  'CORS_ORIGIN',
  'REDIS_URL'
];

// Check for required environment variables
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

export const config: Config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  
  supabase: {
    url: process.env.SUPABASE_URL!,
    anonKey: process.env.SUPABASE_ANON_KEY!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  },
  
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME!,
    apiKey: process.env.CLOUDINARY_API_KEY!,
    apiSecret: process.env.CLOUDINARY_API_SECRET!,
  },
  
  cors: {
    origin: process.env.CORS_ORIGIN 
      ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim())
      : ['http://localhost:3000', 'http://localhost:5173'],
  },
  
  jwt: {
    secret: process.env.JWT_SECRET!,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  
  ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  }),
  
  // Optional configurations
  ...(process.env.REDIS_URL && {
    redis: {
      url: process.env.REDIS_URL,
    },
  }),
  
  ...(process.env.EMAIL_HOST && {
    email: {
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT || '587', 10),
      user: process.env.EMAIL_USER!,
      pass: process.env.EMAIL_PASS!,
    },
  }),
};

// Check for recommended environment variables
for (const envVar of recommendedEnvVars) {
  if (!process.env[envVar]) {
    console.warn(`⚠️  Recommended environment variable not set: ${envVar}`);
  }
}

// Validate configuration
if (config.env === 'production') {
  // Additional production validations
  if (!process.env.CORS_ORIGIN) {
    console.warn('⚠️  CORS_ORIGIN not set in production environment');
  }
  
  if (config.jwt.secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long in production');
  }

  // Production security validations
  if (process.env.FORCE_HTTPS !== 'true') {
    console.warn('⚠️  FORCE_HTTPS not enabled in production');
  }

  if (!process.env.SESSION_SECRET) {
    console.warn('⚠️  SESSION_SECRET not set in production');
  }
}

// Log configuration (without sensitive data)
console.log('📋 Configuration loaded:');
console.log(`   Environment: ${config.env}`);
console.log(`   Port: ${config.port}`);
console.log(`   Supabase URL: ${config.supabase.url}`);
console.log(`   Cloudinary Cloud: ${config.cloudinary.cloudName}`);
console.log(`   CORS Origins: ${Array.isArray(config.cors.origin) ? config.cors.origin.join(', ') : config.cors.origin}`);
if (config.redis) {
  console.log(`   Redis: Connected`);
}
if (config.email) {
  console.log(`   Email: ${config.email.host}:${config.email.port}`);
}

export default config;