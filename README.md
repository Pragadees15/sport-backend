# 🏆 SportsFeed Backend API

A robust, scalable Node.js/TypeScript REST API and real-time server for the SportsFeed social media platform, built with Express.js, Socket.IO, and Supabase.

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.2.2-3178C6?logo=typescript&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.18.2-000000?logo=express&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?logo=supabase&logoColor=white)

## ✨ Features

### 🔐 Authentication & Security
- **JWT Authentication** - Secure token-based authentication with Supabase
- **OAuth Integration** - Google OAuth support
- **Role-Based Access Control** - Multi-role system (user, coach, aspirant, admin)
- **Rate Limiting** - Per-user and IP-based rate limiting
- **Security Headers** - Helmet.js with CSP, HSTS, and XSS protection
- **Input Validation** - Joi schema validation for all endpoints
- **SQL Injection Protection** - Parameterized queries via Supabase
- **Content Moderation** - AI-powered content filtering

### 👥 User Management
- **User Profiles** - Comprehensive profile management
- **Follow System** - User following and followers
- **Verification System** - Document-based verification for coaches and athletes
- **User Discovery** - Advanced search and recommendation algorithms
- **Activity Tracking** - User presence and activity monitoring

### 📝 Content Management
- **Posts & Feed** - Create, edit, delete posts with media support
- **Comments System** - Nested comments with likes
- **Comments System** - Nested comments with likes
- **Media Upload** - Cloudinary integration for images and videos
- **Content Moderation** - Automated and manual content filtering
- **Post Analytics** - Views, likes, shares, and engagement metrics

### 💬 Real-Time Communication
- **Socket.IO Integration** - Real-time bidirectional communication
- **Live Messaging** - One-on-one and group messaging
- **Typing Indicators** - Real-time typing status
- **Online Presence** - User online/offline status tracking
- **Notification Push** - Instant real-time notifications

### 🎮 Gamification System
- **XP & Leveling** - Experience points and level progression
- **Achievements** - Unlockable achievements and badges
- **Daily/Weekly Quests** - Time-bound challenges with rewards
- **Leaderboards** - Global and category-specific rankings
- **Streaks** - Login and activity streak tracking
- **Token Rewards** - XP and token rewards for engagement

### 🎥 Media & Livestreaming
- **Video Library** - Upload, organize, and serve video content
- **Livestreaming** - Create and manage live streams
- **Video Analytics** - View counts, engagement metrics
- **Membership System** - Premium content and token-based access
- **Ad System** - Watch ads to earn tokens

### 🗺️ Location Services
- **Location Check-ins** - Record training locations
- **Safe Locations** - Community-contributed safe spaces
- **Heat Maps** - Visualize activity hotspots
- **Location Discovery** - Find nearby athletes and events

### 🔔 Notifications
- **Real-Time Push** - Socket.IO-powered instant notifications
- **Notification Types** - Likes, comments, follows, mentions, quests
- **Notification Preferences** - User-configurable notification settings
- **Batch Operations** - Mark all as read functionality

### 💰 Token Economy
- **Virtual Currency** - Earn and spend tokens
- **Transaction History** - Complete audit trail
- **Token Transfers** - Send tokens between users
- **Reward System** - Automated token distribution for actions

### 🤖 AI Services
- **AI Content Analysis** - Automated content review
- **Document Verification** - AI-assisted document verification
- **Smart Recommendations** - Personalized content and user suggestions

### 🛡️ Admin & Moderation
- **Admin Dashboard** - Platform management
- **User Management** - Ban, unban, verify users
- **Content Moderation** - Review and moderate content
- **Platform Analytics** - Statistics and reporting

## 🚀 Tech Stack

### Core Framework
- **Node.js 18+** - JavaScript runtime
- **TypeScript** - Type-safe development
- **Express.js** - Web application framework

### Database & Storage
- **Supabase** - PostgreSQL database and authentication
- **Cloudinary** - Media storage and CDN
- **Row Level Security (RLS)** - Database-level access control

### Real-Time & Communication
- **Socket.IO** - WebSocket-based real-time communication
- **HTTP Server** - Express HTTP server

### Security & Middleware
- **Helmet** - Security headers
- **CORS** - Cross-origin resource sharing
- **Rate Limiting** - express-rate-limit
- **Compression** - Response compression
- **Morgan** - HTTP request logging

### Validation & Utilities
- **Joi** - Schema validation
- **Winston** - Structured logging
- **UUID** - Unique identifier generation
- **bcryptjs** - Password hashing
- **jsonwebtoken** - JWT token management

### Development Tools
- **Nodemon** - Development auto-reload
- **ESLint** - Code linting
- **Prettier** - Code formatting
- **Jest** - Testing framework
- **Supertest** - HTTP assertion testing

## 📋 Prerequisites

Before you begin, ensure you have the following installed:
- **Node.js** 18+ ([Download](https://nodejs.org/))
- **npm** 8+ (comes with Node.js)
- **Git** ([Download](https://git-scm.com/))

You'll also need accounts for:
- **Supabase** - Database and authentication ([Sign up](https://supabase.com))
- **Cloudinary** - Media storage ([Sign up](https://cloudinary.com))

## 🛠️ Installation

1. **Navigate to the backend directory**
   ```bash
   cd backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   
   Create a `.env` file in the backend directory:
   ```bash
   cp .env.example .env
   ```
   
   Fill in your environment variables:
   ```env
   # Supabase Configuration
   SUPABASE_URL=your_supabase_project_url
   SUPABASE_ANON_KEY=your_supabase_anon_key
   SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
   
   # JWT Configuration
   JWT_SECRET=your_jwt_secret_key
   
   # Cloudinary Configuration
   CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name
   CLOUDINARY_API_KEY=your_cloudinary_api_key
   CLOUDINARY_API_SECRET=your_cloudinary_api_secret
   
   # Server Configuration
   PORT=5000
   NODE_ENV=development
   
   # CORS Configuration
   CORS_ORIGIN=http://localhost:5173
   ```

4. **Set up the database**
   
   Configure your Supabase database:
   - Navigate to your Supabase project dashboard
   - Set up the required database tables and schema
   - Configure Row Level Security (RLS) policies
   - Additional schema setup may be required. Check the database documentation for complete schema.

5. **Start the development server**
   ```bash
   npm run dev
   ```
   
   The API will be available at `http://localhost:5000`

6. **Verify the server is running**
   ```bash
   curl http://localhost:5000/health
   ```
   
   You should receive a health check response.

## 📜 Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start development server with hot reload (nodemon) |
| `npm run build` | Compile TypeScript to JavaScript (outputs to `dist/`) |
| `npm run start` | Start production server from compiled code |
| `npm run start:dev` | Start development server with ts-node |
| `npm run test` | Run test suite with Jest |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run lint` | Run ESLint to check code quality |
| `npm run lint:fix` | Fix auto-fixable ESLint issues |
| `npm run format` | Format code with Prettier |
| `npm run db:seed` | Seed database with sample data |

## 📁 Project Structure

```
backend/
├── src/
│   ├── config/              # Configuration files
│   │   ├── cloudinary.ts   # Cloudinary client setup
│   │   ├── config.ts       # Environment configuration
│   │   └── supabase.ts     # Supabase client setup
│   ├── middleware/         # Express middleware
│   │   ├── auth.ts         # Authentication middleware
│   │   ├── contentModeration.ts  # Content filtering
│   │   ├── errorHandler.ts # Error handling
│   │   ├── notFound.ts     # 404 handler
│   │   ├── security.ts     # Security headers & rate limiting
│   │   └── validation.ts   # Request validation
│   ├── routes/             # API route handlers
│   │   ├── admin.ts        # Admin endpoints
│   │   ├── ai.ts           # AI service endpoints
│   │   ├── auth.ts         # Authentication routes
│   │   ├── comments.ts     # Comment management
│   │   ├── conversations.ts # Conversation management
│   │   ├── discover.ts     # Discovery & search
│   │   ├── events.ts       # Event management
│   │   ├── gamification.ts # Gamification endpoints
│   │   ├── livestreams.ts  # Livestream management
│   │   ├── locations.ts    # Location services
│   │   ├── memberships.ts  # Membership system
│   │   ├── messages.ts     # Message management
│   │   ├── messaging.ts      # Messaging interface
│   │   ├── notifications.ts # Notification system
│   │   ├── posts.ts        # Post management
│   │   ├── tokens.ts       # Token economy
│   │   ├── upload.ts       # File upload endpoints
│   │   ├── users.ts        # User management
│   │   ├── verification.ts # Verification system
│   │   └── videos.ts       # Video management
│   ├── services/           # Business logic services
│   │   ├── aiService.ts     # AI integration service
│   │   └── gamificationService.ts # Gamification logic
│   ├── socket/              # Socket.IO handlers
│   │   └── socketHandlers.ts # Real-time event handlers
│   ├── utils/               # Utility functions
│   │   ├── logger.ts        # Winston logger setup
│   │   ├── migrateSportsCategories.ts
│   │   └── updateRlsPolicies.ts
│   ├── scripts/             # Utility scripts
│   └── server.ts            # Main server file
├── dist/                    # Compiled JavaScript (generated)
├── logs/                    # Application logs (generated)
├── Procfile                 # Process file for deployment
├── render.yaml              # Render.com deployment config
├── package.json             # Dependencies and scripts
├── tsconfig.json            # TypeScript configuration
└── .env.example             # Environment variables template
```

## 🔌 API Endpoints

### Authentication
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `POST` | `/api/auth/register` | User registration | ❌ |
| `POST` | `/api/auth/login` | User login | ❌ |
| `POST` | `/api/auth/logout` | User logout | ✅ |
| `POST` | `/api/auth/refresh` | Refresh JWT token | ✅ |
| `POST` | `/api/auth/forgot-password` | Password reset request | ❌ |
| `GET` | `/api/auth/me` | Get current user | ✅ |

### Users
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `GET` | `/api/users/profile` | Get current user profile | ✅ |
| `PUT` | `/api/users/profile` | Update user profile | ✅ |
| `GET` | `/api/users/:id` | Get user by ID | ❌ |
| `POST` | `/api/users/:id/follow` | Follow/unfollow user | ✅ |
| `GET` | `/api/users/:id/followers` | Get user followers | ❌ |
| `GET` | `/api/users/:id/following` | Get users being followed | ❌ |
| `GET` | `/api/users/:id/posts` | Get user posts | ❌ |
| `GET` | `/api/users/search` | Search users | ❌ |

### Posts
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `GET` | `/api/posts` | Get posts feed (paginated) | ✅ |
| `POST` | `/api/posts` | Create new post | ✅ |
| `GET` | `/api/posts/:id` | Get specific post | ✅ |
| `PUT` | `/api/posts/:id` | Update post | ✅ |
| `DELETE` | `/api/posts/:id` | Delete post | ✅ |
| `POST` | `/api/posts/:id/like` | Like/unlike post | ✅ |
| `POST` | `/api/posts/:id/share` | Share post | ✅ |
| `GET` | `/api/posts/trending` | Get trending posts | ✅ |

### Comments
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `GET` | `/api/comments/post/:postId` | Get post comments | ✅ |
| `POST` | `/api/comments` | Create comment | ✅ |
| `PUT` | `/api/comments/:id` | Update comment | ✅ |
| `DELETE` | `/api/comments/:id` | Delete comment | ✅ |
| `POST` | `/api/comments/:id/like` | Like/unlike comment | ✅ |

### Messaging
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `GET` | `/api/conversations` | Get user conversations | ✅ |
| `POST` | `/api/conversations` | Create conversation | ✅ |
| `GET` | `/api/conversations/:id` | Get conversation details | ✅ |
| `PUT` | `/api/conversations/:id` | Update conversation | ✅ |
| `GET` | `/api/conversations/:id/messages` | Get conversation messages | ✅ |
| `POST` | `/api/messages` | Send message | ✅ |
| `PUT` | `/api/messages/:id` | Update message | ✅ |
| `DELETE` | `/api/messages/:id` | Delete message | ✅ |

### Notifications
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `GET` | `/api/notifications` | Get user notifications | ✅ |
| `PUT` | `/api/notifications/:id/read` | Mark notification as read | ✅ |
| `PUT` | `/api/notifications/read-all` | Mark all as read | ✅ |
| `DELETE` | `/api/notifications/:id` | Delete notification | ✅ |

### Gamification
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `GET` | `/api/gamification/levels/:userId` | Get user level info | ✅ |
| `GET` | `/api/gamification/achievements` | Get all achievements | ✅ |
| `GET` | `/api/gamification/achievements/user/:userId` | Get user achievements | ✅ |
| `GET` | `/api/gamification/quests` | Get available quests | ✅ |
| `GET` | `/api/gamification/quests/user` | Get user quests | ✅ |
| `POST` | `/api/gamification/quests/:id/claim` | Claim quest reward | ✅ |
| `GET` | `/api/gamification/leaderboard` | Get leaderboards | ✅ |
| `GET` | `/api/gamification/xp/transactions` | Get XP history | ✅ |

### Tokens
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `GET` | `/api/tokens/balance` | Get user token balance | ✅ |
| `GET` | `/api/tokens/transactions` | Get transaction history | ✅ |
| `POST` | `/api/tokens/transfer` | Transfer tokens | ✅ |
| `POST` | `/api/tokens/watch-ad` | Watch ad to earn tokens | ✅ |

### Media & Content
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `POST` | `/api/upload/image` | Upload image | ✅ |
| `POST` | `/api/upload/video` | Upload video | ✅ |
| `DELETE` | `/api/upload/:publicId` | Delete uploaded file | ✅ |
| `GET` | `/api/videos` | Get videos | ❌ |
| `POST` | `/api/videos` | Upload video | ✅ |
| `GET` | `/api/livestreams` | Get livestreams | ❌ |
| `POST` | `/api/livestreams` | Create livestream | ✅ |

### Locations
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `POST` | `/api/locations/check-in` | Check in to location | ✅ |
| `GET` | `/api/locations/check-ins` | Get check-ins | ❌ |
| `POST` | `/api/locations/safe` | Create safe location | ✅ |
| `GET` | `/api/locations/safe` | Get safe locations | ❌ |
| `GET` | `/api/locations/heatmap` | Get heatmap data | ❌ |

### Discovery
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `GET` | `/api/discover/users` | Discover users | ❌ |
| `GET` | `/api/discover/posts` | Discover posts | ❌ |

### Verification
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `POST` | `/api/verification/submit` | Submit verification documents | ✅ |
| `GET` | `/api/verification/status` | Get verification status | ✅ |

### Admin
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `GET` | `/api/admin/users` | Get all users | ✅ Admin |
| `PUT` | `/api/admin/users/:id/ban` | Ban/unban user | ✅ Admin |
| `PUT` | `/api/admin/users/:id/verify` | Verify user | ✅ Admin |
| `GET` | `/api/admin/stats` | Get platform statistics | ✅ Admin |

### Health Check
| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `GET` | `/health` | Server health check | ❌ |

## 🔧 Configuration

### Environment Variables

#### Required Variables
| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anonymous key (for client operations) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (for admin operations) |
| `JWT_SECRET` | Secret key for JWT token signing (use a strong random string) |
| `CLOUDINARY_CLOUD_NAME` | Your Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |

#### Optional Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment (development/production) | `development` |
| `CORS_ORIGIN` | Allowed CORS origins | `*` |

### Security Configuration

The server includes comprehensive security features:
- **Helmet.js** - Sets security headers (CSP, HSTS, X-Frame-Options, etc.)
- **CORS** - Configurable cross-origin resource sharing
- **Rate Limiting** - Per-user and IP-based limits
- **Input Validation** - All requests validated with Joi schemas
- **SQL Injection Protection** - Parameterized queries via Supabase
- **HTTPS Enforcement** - Redirects HTTP to HTTPS in production

### Database Setup

1. Create a Supabase project at [supabase.com](https://supabase.com)
2. Set up the required database tables and schema
3. Configure Row Level Security (RLS) policies
4. Set up database triggers for automated actions

## 🔌 Socket.IO Events

The server uses Socket.IO for real-time features:

### Client → Server Events
- `connection` - Client connects
- `disconnect` - Client disconnects
- `join_room` - Join a room (conversation, livestream)
- `leave_room` - Leave a room
- `send_message` - Send a real-time message
- `typing_start` - Indicate user is typing
- `typing_stop` - Indicate user stopped typing
- `presence_update` - Update user presence status

### Server → Client Events
- `notification` - New notification received
- `message` - New message received
- `typing` - User typing indicator
- `presence` - User presence update
- `livestream_update` - Livestream status update

## 🧪 Testing

### Run Tests
```bash
npm test
```

### Watch Mode
```bash
npm run test:watch
```

### Coverage Report
```bash
npm run test:coverage
```

## 🚢 Deployment

### Building for Production

1. **Build the application**
   ```bash
   npm run build
   ```

2. **Set production environment variables**
   - Ensure all required environment variables are set
   - Use strong secrets for production
   - Enable HTTPS

3. **Start the production server**
   ```bash
   npm start
   ```

### Deployment Platforms

The project includes configuration files for:
- **Render** - `render.yaml` and `Procfile`
- **Heroku** - `Procfile`

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure strong `JWT_SECRET`
- [ ] Set up HTTPS certificates
- [ ] Configure CORS origins properly
- [ ] Set up database backups
- [ ] Configure logging and monitoring
- [ ] Set up error tracking (Sentry, etc.)
- [ ] Enable rate limiting
- [ ] Review security headers

## 🐛 Troubleshooting

### Common Issues

**Database Connection Errors**
- Verify Supabase credentials in `.env`
- Check Supabase project status
- Verify network connectivity

**Port Already in Use**
```bash
# Windows
netstat -ano | findstr :5000
taskkill /PID <PID> /F

# Mac/Linux
lsof -ti:5000 | xargs kill
```

**Environment Variables Not Loading**
- Ensure `.env` file is in `backend/` directory
- Restart server after changing `.env`
- Verify variable names match exactly

**TypeScript Compilation Errors**
- Clear `dist/` folder: `rm -rf dist`
- Reinstall dependencies: `rm -rf node_modules && npm install`
- Check TypeScript version compatibility

**Socket.IO Connection Issues**
- Verify CORS configuration includes frontend URL
- Check WebSocket support in hosting environment
- Ensure firewall allows WebSocket connections

## 📊 Monitoring & Logging

### Logging

The application uses Winston for structured logging:
- **Info** - General application flow
- **Error** - Errors and exceptions
- **Warn** - Warning messages
- **Debug** - Detailed debugging information (development only)

Logs are written to:
- Console (development)
- `logs/` directory (production)

### Health Check

Monitor server health:
```bash
curl http://localhost:5000/health
```

Response includes:
- Server status
- Uptime
- Environment
- Timestamp

## 🤝 Contributing

1. Create a feature branch
2. Make your changes
3. Add tests for new features
4. Run linting: `npm run lint`
5. Run tests: `npm test`
6. Update documentation
7. Submit a pull request

### Code Style

- Use TypeScript for all new code
- Follow Express.js best practices
- Use async/await for asynchronous operations
- Validate all inputs with Joi
- Handle errors gracefully
- Write meaningful commit messages

## 📄 License

MIT License - see LICENSE file for details

## 🙏 Acknowledgments

- Built with [Express.js](https://expressjs.com/)
- Real-time powered by [Socket.IO](https://socket.io/)
- Database by [Supabase](https://supabase.com/)
- Media storage by [Cloudinary](https://cloudinary.com/)

---

**Happy coding! 🚀**
