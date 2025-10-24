import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { supabase, supabaseAdmin } from '../config/supabase';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userEmail?: string;
}

interface OnlineUser {
  id: string;
  email: string;
  socketId: string;
  lastSeen: Date;
}

const onlineUsers = new Map<string, OnlineUser>();
const userRooms = new Map<string, Set<string>>();
const locationUsers = new Map<string, Set<string>>(); // locationId -> Set of userIds
const userLocations = new Map<string, string>(); // userId -> current locationId

export const setupSocketHandlers = (io: Server) => {
  // Authentication middleware for Socket.IO
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
      
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      // Verify token with Supabase
      const { data: { user }, error } = await supabase.auth.getUser(token);
      
      if (error || !user) {
        return next(new Error('Authentication error: Invalid token'));
      }

      socket.userId = user.id;
      socket.userEmail = user.email;
      next();
    } catch (error) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    console.log(`User connected: ${socket.userId} (${socket.userEmail})`);

    // Add user to online users
    if (socket.userId && socket.userEmail) {
      onlineUsers.set(socket.userId, {
        id: socket.userId,
        email: socket.userEmail,
        socketId: socket.id,
        lastSeen: new Date()
      });

      // Broadcast user came online
      io.emit('userOnline', socket.userId);
      
      // Broadcast updated online users list
      io.emit('usersOnline', Array.from(onlineUsers.keys()));
    }

    // Join user to their personal room
    if (socket.userId) {
      socket.join(`user:${socket.userId}`);
      
      // Send current online users list to the newly connected user
      socket.emit('usersOnline', Array.from(onlineUsers.keys()));
    }

    // Handle joining conversation rooms
    socket.on('joinConversation', async (conversationId: string) => {
      try {
        // Verify user is participant in conversation
        const { data: participant } = await supabaseAdmin
          .from('conversation_participants')
          .select('*')
          .eq('conversation_id', conversationId)
          .eq('user_id', socket.userId)
          .single();

        if (participant) {
          socket.join(`conversation:${conversationId}`);
          
          // Track user rooms
          if (!userRooms.has(socket.userId!)) {
            userRooms.set(socket.userId!, new Set());
          }
          userRooms.get(socket.userId!)?.add(`conversation:${conversationId}`);
          
          console.log(`User ${socket.userId} joined conversation ${conversationId}`);
        }
      } catch (error) {
        console.error('Error joining conversation:', error);
        socket.emit('error', { message: 'Failed to join conversation' });
      }
    });

    // Handle leaving conversation rooms
    socket.on('leaveConversation', (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
      userRooms.get(socket.userId!)?.delete(`conversation:${conversationId}`);
      console.log(`User ${socket.userId} left conversation ${conversationId}`);
    });

    // Handle sending messages
    socket.on('sendMessage', async (data: {
      conversationId: string;
      content: string;
      type: 'text' | 'image' | 'video' | 'audio';
      mediaUrl?: string;
    }) => {
      try {
        // Verify user is participant
        const { data: participant } = await supabaseAdmin
          .from('conversation_participants')
          .select('*')
          .eq('conversation_id', data.conversationId)
          .eq('user_id', socket.userId)
          .single();

        if (!participant) {
          socket.emit('error', { message: 'Not authorized to send messages in this conversation' });
          return;
        }

        // Create message in database
        const { data: message, error } = await supabaseAdmin
          .from('messages')
          .insert({
            conversation_id: data.conversationId,
            sender_id: socket.userId,
            content: data.content,
            type: data.type,
            media_url: data.mediaUrl,
            created_at: new Date().toISOString()
          })
          .select(`
            *,
            sender:users!sender_id(
              id,
              name,
              avatar_url,
              role
            )
          `)
          .single();

        if (error) {
          socket.emit('error', { message: 'Failed to send message' });
          return;
        }

        // Broadcast message to conversation room
        io.to(`conversation:${data.conversationId}`).emit('newMessage', message);

        // Update conversation last_message_at
        await supabaseAdmin
          .from('conversations')
          .update({ 
            last_message_at: new Date().toISOString(),
            last_message: data.content
          })
          .eq('id', data.conversationId);

      } catch (error) {
        console.error('Error sending message:', error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // Handle typing indicators
    socket.on('typing', (data: { conversationId: string; isTyping: boolean }) => {
      socket.to(`conversation:${data.conversationId}`).emit('userTyping', {
        userId: socket.userId,
        isTyping: data.isTyping
      });
    });

    // Handle livestream events
    socket.on('joinLivestream', async (livestreamId: string) => {
      socket.join(`livestream:${livestreamId}`);
      
      // Get current viewer count from database
      const { data: livestream, error } = await supabaseAdmin
        .from('livestreams')
        .select('viewers_count')
        .eq('id', livestreamId)
        .single();

      if (!error && livestream) {
        const newViewerCount = (livestream.viewers_count || 0) + 1;
        
        // Update viewer count in database
        await supabaseAdmin
          .from('livestreams')
          .update({ viewers_count: newViewerCount })
          .eq('id', livestreamId);

        // Broadcast to all viewers in the livestream room
        io.to(`livestream:${livestreamId}`).emit('viewerJoined', {
          livestreamId,
          userId: socket.userId,
          userEmail: socket.userEmail,
          viewerCount: newViewerCount
        });
      }
    });

    socket.on('leaveLivestream', async (livestreamId: string) => {
      socket.leave(`livestream:${livestreamId}`);
      
      // Get current viewer count from database
      const { data: livestream, error } = await supabaseAdmin
        .from('livestreams')
        .select('viewers_count')
        .eq('id', livestreamId)
        .single();

      if (!error && livestream) {
        const newViewerCount = Math.max((livestream.viewers_count || 0) - 1, 0);
        
        // Update viewer count in database
        await supabaseAdmin
          .from('livestreams')
          .update({ viewers_count: newViewerCount })
          .eq('id', livestreamId);

        // Broadcast to all viewers in the livestream room
        io.to(`livestream:${livestreamId}`).emit('viewerLeft', {
          livestreamId,
          userId: socket.userId,
          viewerCount: newViewerCount
        });
      }
    });

    // Handle livestream status updates
    socket.on('updateLivestreamStatus', async (data: {
      livestreamId: string;
      isLive: boolean;
    }) => {
      try {
        const updateData: any = { is_live: data.isLive };
        
        if (data.isLive) {
          updateData.started_at = new Date().toISOString();
        } else {
          updateData.ended_at = new Date().toISOString();
        }

        const { error } = await supabaseAdmin
          .from('livestreams')
          .update(updateData)
          .eq('id', data.livestreamId);

        if (!error) {
          // Broadcast status update to all viewers
          io.to(`livestream:${data.livestreamId}`).emit('livestreamStatusUpdate', {
            livestreamId: data.livestreamId,
            isLive: data.isLive,
            startedAt: data.isLive ? updateData.started_at : undefined,
            endedAt: data.isLive ? undefined : updateData.ended_at
          });
        }
      } catch (error) {
        console.error('Error updating livestream status:', error);
      }
    });

    // Handle location updates
    socket.on('locationUpdate', async (data: {
      latitude: number;
      longitude: number;
      accuracy?: number;
    }) => {
      try {
        // Update user's last known location
        await supabaseAdmin
          .from('users')
          .update({
            last_latitude: data.latitude,
            last_longitude: data.longitude,
            last_location_update: new Date().toISOString()
          })
          .eq('id', socket.userId);

        // Broadcast to nearby users if needed
        socket.broadcast.emit('nearbyUserUpdate', {
          userId: socket.userId,
          latitude: data.latitude,
          longitude: data.longitude
        });
      } catch (error) {
        console.error('Error updating location:', error);
      }
    });

    // Handle joining a location (for active user tracking)
    socket.on('joinLocation', async (data: {
      locationId: string;
      originalLocationId?: string;
      latitude: number;
      longitude: number;
      locationName?: string;
    }) => {
      try {
        if (!socket.userId) return;

        // Leave previous location if any
        const previousLocationId = userLocations.get(socket.userId);
        if (previousLocationId) {
          socket.leave(`location:${previousLocationId}`);
          const locationUserSet = locationUsers.get(previousLocationId);
          if (locationUserSet) {
            locationUserSet.delete(socket.userId);
            if (locationUserSet.size === 0) {
              locationUsers.delete(previousLocationId);
            }
            // Broadcast updated user count to previous location
            io.to(`location:${previousLocationId}`).emit('locationUserCountUpdate', {
              locationId: previousLocationId,
              userCount: locationUserSet.size,
              users: Array.from(locationUserSet)
            });
          }
        }

        // Join new location
        socket.join(`location:${data.locationId}`);
        userLocations.set(socket.userId, data.locationId);
        
        if (!locationUsers.has(data.locationId)) {
          locationUsers.set(data.locationId, new Set());
        }
        locationUsers.get(data.locationId)!.add(socket.userId);

        // Get user info for broadcasting
        const { data: userData } = await supabaseAdmin
          .from('users')
          .select('id, name, avatar_url')
          .eq('id', socket.userId)
          .single();

        // Broadcast updated user count and user joined event
        const currentUsers = locationUsers.get(data.locationId)!;
        io.to(`location:${data.locationId}`).emit('locationUserCountUpdate', {
          locationId: data.locationId,
          userCount: currentUsers.size,
          users: Array.from(currentUsers)
        });

        io.to(`location:${data.locationId}`).emit('userJoinedLocation', {
          locationId: data.locationId,
          user: userData,
          timestamp: new Date().toISOString()
        });

        console.log(`User ${socket.userId} joined location ${data.locationId}`);
      } catch (error) {
        console.error('Error joining location:', error);
        socket.emit('error', { message: 'Failed to join location' });
      }
    });

    // Handle leaving a location
    socket.on('leaveLocation', (locationId: string) => {
      if (!socket.userId) return;

      socket.leave(`location:${locationId}`);
      userLocations.delete(socket.userId);
      
      const locationUserSet = locationUsers.get(locationId);
      if (locationUserSet) {
        locationUserSet.delete(socket.userId);
        if (locationUserSet.size === 0) {
          locationUsers.delete(locationId);
        }
        
        // Broadcast updated user count and user left event
        io.to(`location:${locationId}`).emit('locationUserCountUpdate', {
          locationId,
          userCount: locationUserSet.size,
          users: Array.from(locationUserSet)
        });

        io.to(`location:${locationId}`).emit('userLeftLocation', {
          locationId,
          userId: socket.userId,
          timestamp: new Date().toISOString()
        });
      }

      console.log(`User ${socket.userId} left location ${locationId}`);
    });

    // Handle getting current users at a location
    socket.on('getLocationUsers', (locationId: string) => {
      const users = locationUsers.get(locationId);
      socket.emit('locationUsersResponse', {
        locationId,
        userCount: users ? users.size : 0,
        users: users ? Array.from(users) : []
      });
    });

    // Handle notifications
    socket.on('markNotificationRead', async (notificationId: string) => {
      try {
        await supabaseAdmin
          .from('notifications')
          .update({ is_read: true, read_at: new Date().toISOString() })
          .eq('id', notificationId)
          .eq('user_id', socket.userId);

        // Emit both names for compatibility with different UI listeners
        socket.emit('notificationRead', notificationId);
        socket.emit('notificationMarkedRead', { notificationId });
      } catch (error) {
        console.error('Error marking notification as read:', error);
      }
    });

    // Handle request for current online users
    socket.on('getOnlineUsers', () => {
      socket.emit('usersOnline', Array.from(onlineUsers.keys()));
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log(`User disconnected: ${socket.userId}`);
      
      if (socket.userId) {
        // Remove from online users
        onlineUsers.delete(socket.userId);
        
        // Clean up user rooms
        userRooms.delete(socket.userId);
        
        // Clean up location tracking
        const currentLocationId = userLocations.get(socket.userId);
        if (currentLocationId) {
          const locationUserSet = locationUsers.get(currentLocationId);
          if (locationUserSet) {
            locationUserSet.delete(socket.userId);
            if (locationUserSet.size === 0) {
              locationUsers.delete(currentLocationId);
            }
            
            // Broadcast updated user count
            io.to(`location:${currentLocationId}`).emit('locationUserCountUpdate', {
              locationId: currentLocationId,
              userCount: locationUserSet.size,
              users: Array.from(locationUserSet)
            });

            io.to(`location:${currentLocationId}`).emit('userLeftLocation', {
              locationId: currentLocationId,
              userId: socket.userId,
              timestamp: new Date().toISOString()
            });
          }
          userLocations.delete(socket.userId);
        }
        
        // Broadcast user went offline
        io.emit('userOffline', socket.userId);
        
        // Broadcast updated online users list
        io.emit('usersOnline', Array.from(onlineUsers.keys()));
      }
    });
  });

  // Helper function to send notification to user
  const sendNotificationToUser = (userId: string, notification: any) => {
    io.to(`user:${userId}`).emit('newNotification', notification);
  };

  // Helper to emit any event to a specific user
  const emitToUser = (userId: string, event: string, payload: any) => {
    io.to(`user:${userId}`).emit(event, payload);
  };

  // Helper function to broadcast to conversation
  const broadcastToConversation = (conversationId: string, event: string, data: any) => {
    io.to(`conversation:${conversationId}`).emit(event, data);
  };

  // Export helper functions
  return {
    sendNotificationToUser,
    emitToUser,
    broadcastToConversation,
    getOnlineUsers: () => Array.from(onlineUsers.values()),
    isUserOnline: (userId: string) => onlineUsers.has(userId),
    getLocationUsers: (locationId: string) => {
      const users = locationUsers.get(locationId);
      return users ? Array.from(users) : [];
    },
    getLocationUserCount: (locationId: string) => {
      const users = locationUsers.get(locationId);
      return users ? users.size : 0;
    },
    broadcastToLocation: (locationId: string, event: string, data: any) => {
      io.to(`location:${locationId}`).emit(event, data);
    }
  };
};