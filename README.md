# SportsFeed Backend API

A robust Node.js/TypeScript backend API for the SportsFeed social media platform, built with Express.js and Supabase.

## Features

- 🔐 **Authentication & Authorization** - JWT-based auth with Supabase
- 👥 **User Management** - Profiles, following, verification system
- 📝 **Posts & Comments** - Create, edit, delete posts with media support
- 💬 **Real-time Messaging** - Socket.IO powered chat system
- 🔔 **Notifications** - Real-time push notifications
- 🪙 **Token System** - Virtual currency for platform engagement
- 📁 **File Uploads** - Cloudinary integration for media storage
- 🛡️ **Security** - Rate limiting, CORS, Helmet protection
- 📊 **Logging** - Winston-based structured logging
- 🏃‍♂️ **Performance** - Compression, caching, optimized queries

## Tech Stack

- **Runtime**: Node.js 18+
- **Language**: TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL (via Supabase)
- **Authentication**: Supabase Auth + JWT
- **File Storage**: Cloudinary
- **Real-time**: Socket.IO
- **Logging**: Winston
- **Validation**: Joi
- **Testing**: Jest + Supertest

## Quick Start

### Prerequisites

- Node.js 18+ and npm 8+
- Supabase account and project
- Cloudinary account (for file uploads)

### Installation

1. **Clone and install dependencies**:
   ```bash
   cd backend
   npm install
   ```

2. **Environment Setup**:
   ```bash
   cp .env.example .env
   ```
   
   Fill in your environment variables:
   - `SUPABASE_URL` and `SUPABASE_ANON_KEY` from your Supabase project
   - `SUPABASE_SERVICE_ROLE_KEY` for admin operations
   - `CLOUDINARY_*` credentials for file uploads
   - `JWT_SECRET` for token signing

3. **Database Setup**:
   - Run the SQL schema in `database/schema.sql` in your Supabase SQL editor
   - This creates all tables, RLS policies, functions, and triggers

4. **Start Development Server**:
   ```bash
   npm run dev
   ```

   The API will be available at `http://localhost:5000`

## API Endpoints

### Authentication
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout
- `POST /api/auth/refresh` - Refresh JWT token
- `POST /api/auth/forgot-password` - Password reset

### Users
- `GET /api/users/profile` - Get current user profile
- `PUT /api/users/profile` - Update user profile
- `GET /api/users/:id` - Get user by ID
- `POST /api/users/:id/follow` - Follow/unfollow user
- `GET /api/users/:id/followers` - Get user followers
- `GET /api/users/:id/following` - Get users being followed

### Posts
- `GET /api/posts` - Get posts feed
- `POST /api/posts` - Create new post
- `GET /api/posts/:id` - Get specific post
- `PUT /api/posts/:id` - Update post
- `DELETE /api/posts/:id` - Delete post
- `POST /api/posts/:id/like` - Like/unlike post
- `POST /api/posts/:id/share` - Share post

### Comments
- `GET /api/comments/post/:postId` - Get post comments
- `POST /api/comments` - Create comment
- `PUT /api/comments/:id` - Update comment
- `DELETE /api/comments/:id` - Delete comment
- `POST /api/comments/:id/like` - Like/unlike comment

### Messages
- `GET /api/conversations` - Get user conversations
- `POST /api/conversations` - Create conversation
- `GET /api/conversations/:id/messages` - Get conversation messages
- `POST /api/messages` - Send message
- `PUT /api/messages/:id` - Update message
- `DELETE /api/messages/:id` - Delete message

### Notifications
- `GET /api/notifications` - Get user notifications
- `PUT /api/notifications/:id/read` - Mark notification as read
- `PUT /api/notifications/read-all` - Mark all notifications as read

### Tokens
- `GET /api/tokens/balance` - Get user token balance
- `GET /api/tokens/transactions` - Get token transaction history
- `POST /api/tokens/transfer` - Transfer tokens to another user

### File Upload
- `POST /api/upload/image` - Upload image file
- `POST /api/upload/video` - Upload video file
- `DELETE /api/upload/:publicId` - Delete uploaded file

### Admin (Admin only)
- `GET /api/admin/users` - Get all users
- `PUT /api/admin/users/:id/ban` - Ban/unban user
- `PUT /api/admin/users/:id/verify` - Verify user
- `GET /api/admin/reports` - Get content reports
- `GET /api/admin/stats` - Get platform statistics

## Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run test` - Run tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage
- `npm run lint` - Lint code
- `npm run lint:fix` - Fix linting issues
- `npm run format` - Format code with Prettier

## Project Structure

```
src/
├── config/          # Configuration files
├── middleware/      # Express middleware
├── routes/          # API route handlers
├── utils/           # Utility functions
├── types/           # TypeScript type definitions
└── server.ts        # Main server file

database/
└── schema.sql       # Database schema and setup

logs/               # Application logs (created at runtime)
dist/               # Compiled JavaScript (created on build)
```

## Environment Variables

See `.env.example` for all required and optional environment variables.

### Required Variables
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Supabase anonymous key
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
- `JWT_SECRET` - Secret for JWT token signing
- `CLOUDINARY_CLOUD_NAME` - Cloudinary cloud name
- `CLOUDINARY_API_KEY` - Cloudinary API key
- `CLOUDINARY_API_SECRET` - Cloudinary API secret

## Security Features

- **JWT Authentication** - Secure token-based authentication
- **Rate Limiting** - Prevents API abuse
- **CORS Protection** - Configurable cross-origin requests
- **Helmet Security** - Security headers and CSP
- **Input Validation** - Joi schema validation
- **SQL Injection Protection** - Parameterized queries via Supabase
- **Row Level Security** - Database-level access control

## Real-time Features

- **Live Messaging** - Real-time chat with Socket.IO
- **Notification Push** - Instant notification delivery
- **Online Status** - User presence tracking
- **Typing Indicators** - Real-time typing status

## Error Handling

- Centralized error handling middleware
- Structured error logging with Winston
- Graceful error responses
- Development vs production error details

## Testing

Run the test suite:
```bash
npm test
```

For test coverage:
```bash
npm run test:coverage
```

## Deployment

1. **Build the application**:
   ```bash
   npm run build
   ```

2. **Set production environment variables**

3. **Start the production server**:
   ```bash
   npm start
   ```

## Contributing

1. Follow the existing code style
2. Add tests for new features
3. Update documentation as needed
4. Use conventional commit messages

## License

MIT License - see LICENSE file for details