import express, { Response } from 'express';
import multer from 'multer';
import { cloudinary, deleteFromCloudinary, uploadToCloudinary } from '../config/cloudinary';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { supabase, supabaseAdmin } from '../config/supabase';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Test endpoint to check uploads table
router.get('/test-table', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Test if table exists and is accessible
    const { data, error } = await supabaseAdmin
      .from('uploads')
      .select('count')
      .limit(1);

    if (error) {
      res.status(500).json({
        success: false,
        error: 'Table access error',
        details: error.message,
        code: error.code
      });
      return;
    }

    // Test insert with minimal data
    const testData = {
      id: uuidv4(),
      user_id: req.user!.id,
      filename: 'test.txt',
      cloudinary_public_id: 'test-public-id',
      cloudinary_url: 'https://test.com/test.txt',
      file_type: 'document',
      file_size: 100,
      mime_type: 'text/plain',
      folder: 'test',
      tags: ['test']
    };

    const { data: insertData, error: insertError } = await supabaseAdmin
      .from('uploads')
      .insert(testData)
      .select()
      .single();

    if (insertError) {
      res.status(500).json({
        success: false,
        error: 'Insert test failed',
        details: insertError.message,
        code: insertError.code,
        hint: insertError.hint
      });
      return;
    }

    // Clean up test data
    await supabaseAdmin
      .from('uploads')
      .delete()
      .eq('id', insertData.id);

    res.json({
      success: true,
      message: 'Uploads table is working correctly',
      testData: insertData
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'Test failed',
      details: error.message
    });
  }
}));

// Configure multer for memory storage
const storage = multer.memoryStorage();

// File filter function
const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedTypes = {
    image: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
    video: ['video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/flv', 'video/webm'],
    audio: ['audio/mp3', 'audio/wav', 'audio/ogg', 'audio/m4a'],
    document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
  };

  const allAllowedTypes = Object.values(allowedTypes).flat();
  
  if (allAllowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} is not allowed`));
  }
};

// Configure multer with size limits
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
    files: 10 // Max 10 files per request
  }
});

// Helper function to determine file type
const getFileType = (mimetype: string): string => {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
};

// Helper function to generate unique filename
const generateFileName = (originalName: string, userId: string): string => {
  const ext = path.extname(originalName);
  const name = path.basename(originalName, ext);
  const timestamp = Date.now();
  const uuid = uuidv4().split('-')[0];
  return `${userId}/${timestamp}-${uuid}-${name}${ext}`;
};

// Upload single file
router.post('/single', authenticateToken, upload.single('file'), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({
      success: false,
      error: 'No file provided'
    });
    return;
  }

  const { folder = 'general', tags = '' } = req.body;
  const fileType = getFileType(req.file.mimetype);
  const fileName = generateFileName(req.file.originalname, req.user!.id);

  try {
    const result = await uploadToCloudinary(
      req.file.buffer,
      {
        folder: `sportsfeed/${folder}`,
        public_id: fileName,
        resource_type: fileType === 'video' ? 'video' : fileType === 'document' ? 'raw' : 'image',
        // Use eager_async for faster image uploads - transformations happen in background
        eager_async: fileType === 'image',
        tags: tags ? tags.split(',').map((tag: string) => tag.trim()) : [],
        context: {
          user_id: req.user!.id,
          upload_date: new Date().toISOString()
        }
      }
    ) as any;

    // Save upload record to database using admin client to bypass RLS
    let uploadRecord = null;
    try {
      const { data, error: dbError } = await supabaseAdmin
        .from('uploads')
        .insert({
          id: uuidv4(),
          user_id: req.user!.id,
          filename: req.file.originalname,
          cloudinary_public_id: result.public_id,
          cloudinary_url: result.secure_url,
          file_type: fileType,
          file_size: req.file.size,
          mime_type: req.file.mimetype,
          folder,
          tags: tags ? tags.split(',').map((tag: string) => tag.trim()) : [],
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (dbError) {
        console.error('Database error:', dbError);
        // If database save fails, delete from Cloudinary
        await deleteFromCloudinary(result.public_id, fileType === 'video' ? 'video' : fileType === 'document' ? 'raw' : 'image');
        throw new Error(`Failed to save upload record: ${dbError.message}`);
      }
      
      uploadRecord = data;
    } catch (dbError: any) {
      console.error('Upload record save failed:', dbError);
      // If database save fails, delete from Cloudinary
      try {
        await deleteFromCloudinary(result.public_id, fileType === 'video' ? 'video' : fileType === 'document' ? 'raw' : 'image');
      } catch (deleteError) {
        console.error('Failed to delete from Cloudinary:', deleteError);
      }
      throw new Error(`Failed to save upload record: ${dbError.message}`);
    }

    res.json({
      success: true,
      message: 'File uploaded successfully',
      file: {
        id: uploadRecord?.id || 'temp-id',
        url: result.secure_url,
        publicId: result.public_id,
        type: fileType,
        size: req.file.size,
        originalName: req.file.originalname,
        width: result.width,
        height: result.height,
        format: result.format
      }
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      error: error.message || 'Upload failed'
    });
  }
}));

// Upload multiple files
router.post('/multiple', authenticateToken, upload.array('files', 10), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const files = req.files as Express.Multer.File[];
  
  if (!files || files.length === 0) {
    res.status(400).json({
      success: false,
      error: 'No files provided'
    });
    return;
  }

  const { folder = 'general', tags = '' } = req.body;
  const uploadPromises: Promise<any>[] = [];
  const uploadRecords: any[] = [];

  try {
    // Upload all files to Cloudinary
    for (const file of files) {
      const fileType = getFileType(file.mimetype);
      const fileName = generateFileName(file.originalname, req.user!.id);

      const uploadPromise = uploadToCloudinary(
        file.buffer,
        {
          folder: `sportsfeed/${folder}`,
          public_id: fileName,
          resource_type: fileType === 'video' ? 'video' : fileType === 'document' ? 'raw' : 'image',
          tags: tags ? tags.split(',').map((tag: string) => tag.trim()) : [],
          context: {
            user_id: req.user!.id,
            upload_date: new Date().toISOString()
          }
        }
      ).then((result: any) => ({
        file,
        result,
        fileType
      }));

      uploadPromises.push(uploadPromise);
    }

    const uploadResults = await Promise.all(uploadPromises);

    // Save all upload records to database
    for (const { file, result, fileType } of uploadResults) {
      uploadRecords.push({
        id: uuidv4(),
        user_id: req.user!.id,
        filename: file.originalname,
        cloudinary_public_id: result.public_id,
        cloudinary_url: result.secure_url,
        file_type: fileType,
        file_size: file.size,
        mime_type: file.mimetype,
        folder,
        tags: tags ? tags.split(',').map((tag: string) => tag.trim()) : [],
        created_at: new Date().toISOString()
      });
    }

    const { data: savedRecords, error: dbError } = await supabaseAdmin
      .from('uploads')
      .insert(uploadRecords)
      .select();

    if (dbError) {
      // If database save fails, delete all files from Cloudinary
      for (const { result, fileType } of uploadResults) {
        await deleteFromCloudinary(result.public_id, fileType === 'video' ? 'video' : fileType === 'document' ? 'raw' : 'image');
      }
      throw new Error('Failed to save upload records');
    }

    const responseFiles = uploadResults.map((upload, index) => ({
      id: savedRecords[index].id,
      url: upload.result.secure_url,
      publicId: upload.result.public_id,
      type: upload.fileType,
      size: upload.file.size,
      originalName: upload.file.originalname,
      width: upload.result.width,
      height: upload.result.height,
      format: upload.result.format
    }));

    res.json({
      success: true,
      message: `${files.length} files uploaded successfully`,
      files: responseFiles
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      error: error.message || 'Upload failed'
    });
  }
}));

// Upload avatar/profile image
router.post('/avatar', authenticateToken, upload.single('avatar'), asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({
      success: false,
      error: 'No avatar file provided'
    });
    return;
  }

  const fileType = getFileType(req.file.mimetype);
  
  if (fileType !== 'image') {
    res.status(400).json({
      success: false,
      error: 'Avatar must be an image file'
    });
    return;
  }

  try {
    // Delete old avatar if exists
    const { data: currentUser } = await supabaseAdmin
      .from('users')
      .select('avatar_url')
      .eq('id', req.user!.id)
      .single();

    if (currentUser?.avatar_url) {
      // Extract public_id from Cloudinary URL
      const urlParts = currentUser.avatar_url.split('/');
      const publicIdWithExt = urlParts[urlParts.length - 1];
      const publicId = publicIdWithExt.split('.')[0];
      
      try {
        await deleteFromCloudinary(`sportsfeed/avatars/${publicId}`, 'image');
      } catch (deleteError) {
        console.warn('Failed to delete old avatar:', deleteError);
      }
    }

    const fileName = `${req.user!.id}-${Date.now()}`;
    
    const result = await uploadToCloudinary(
      req.file.buffer,
      {
        folder: 'sportsfeed/avatars',
        public_id: fileName,
        resource_type: 'image',
        // Use eager_async for faster uploads - transformations happen in background
        eager_async: true,
        eager: [
          { width: 400, height: 400, crop: 'fill', gravity: 'face', quality: 'auto', fetch_format: 'auto' }
        ],
        // Store the base transformation parameters
        transformation: [
          { width: 400, height: 400, crop: 'fill', gravity: 'face' },
          { quality: 'auto', fetch_format: 'auto' }
        ],
        context: {
          user_id: req.user!.id,
          type: 'avatar',
          upload_date: new Date().toISOString()
        }
      }
    ) as any;

    // Update user's avatar URL
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({ avatar_url: result.secure_url })
      .eq('id', req.user!.id);

    if (updateError) {
      // If user update fails, delete the uploaded image
      await deleteFromCloudinary(result.public_id, 'image');
      throw new Error('Failed to update user avatar');
    }

    // Save upload record
    await supabaseAdmin
      .from('uploads')
      .insert({
        id: uuidv4(),
        user_id: req.user!.id,
        filename: req.file.originalname,
        cloudinary_public_id: result.public_id,
        cloudinary_url: result.secure_url,
        file_type: 'image',
        file_size: req.file.size,
        mime_type: req.file.mimetype,
        folder: 'avatars',
        tags: ['avatar', 'profile'],
        created_at: new Date().toISOString()
      });

    res.json({
      success: true,
      message: 'Avatar uploaded successfully',
      avatarUrl: result.secure_url
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      error: error.message || 'Avatar upload failed'
    });
  }
}));

// Get user's uploads
router.get('/my-uploads', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const {
    page = 1,
    limit = 20,
    type,
    folder
  } = req.query as any;

  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from('uploads')
    .select('*', { count: 'exact' })
    .eq('user_id', req.user!.id)
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false });

  if (type) {
    query = query.eq('file_type', type);
  }

  if (folder) {
    query = query.eq('folder', folder);
  }

  const { data: uploads, error, count } = await query;

  if (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to fetch uploads'
    });
    return;
  }

  const totalPages = Math.ceil((count || 0) / limit);

  res.json({
    success: true,
    uploads: uploads || [],
    pagination: {
      currentPage: page,
      totalPages,
      totalUploads: count,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  });
}));

// Delete upload
router.delete('/:uploadId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { uploadId } = req.params;

  // Get upload record
  const { data: upload, error: fetchError } = await supabaseAdmin
    .from('uploads')
    .select('*')
    .eq('id', uploadId)
    .eq('user_id', req.user!.id)
    .single();

  if (fetchError || !upload) {
    res.status(404).json({
      success: false,
      error: 'Upload not found'
    });
    return;
  }

  try {
    // Delete from Cloudinary
    const resourceType = upload.file_type === 'video' ? 'video' : upload.file_type === 'document' ? 'raw' : 'image';
    await deleteFromCloudinary(upload.cloudinary_public_id, resourceType);

    // Delete from database
    const { error: deleteError } = await supabaseAdmin
      .from('uploads')
      .delete()
      .eq('id', uploadId);

    if (deleteError) {
      throw new Error('Failed to delete upload record');
    }

    res.json({
      success: true,
      message: 'Upload deleted successfully'
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to delete upload'
    });
  }
}));

// Get upload by ID
router.get('/:uploadId', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { uploadId } = req.params;

  const { data: upload, error } = await supabaseAdmin
    .from('uploads')
    .select(`
      *,
      user:users!user_id(
        id,
        name,
        avatar_url
      )
    `)
    .eq('id', uploadId)
    .single();

  if (error || !upload) {
    res.status(404).json({
      success: false,
      error: 'Upload not found'
    });
    return;
  }

  // Check if user owns the upload or if it's public
  if (upload.user_id !== req.user!.id) {
    res.status(403).json({
      success: false,
      error: 'Not authorized to view this upload'
    });
    return;
  }

  res.json({
    success: true,
    upload
  });
}));

// Generate signed URL for secure uploads (for large files)
router.post('/signed-url', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { folder = 'general', resourceType = 'image' } = req.body;

  const timestamp = Math.round(new Date().getTime() / 1000);
  const publicId = `${req.user!.id}/${timestamp}-${uuidv4()}`;

  const params = {
    timestamp,
    public_id: publicId,
    folder: `sportsfeed/${folder}`,
    resource_type: resourceType,
    context: `user_id=${req.user!.id}|upload_date=${new Date().toISOString()}`
  };

  const signature = cloudinary.utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET!);

  res.json({
    success: true,
    signature,
    timestamp,
    publicId,
    apiKey: process.env.CLOUDINARY_API_KEY,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`
  });
}));

// Get upload statistics
router.get('/stats', authenticateToken, asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  // Get total uploads count
  const { count: totalUploads } = await supabaseAdmin
    .from('uploads')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  // Get uploads by type
  const { data: uploadsByType } = await supabaseAdmin
    .from('uploads')
    .select('file_type, file_size')
    .eq('user_id', userId);

  const typeStats = uploadsByType?.reduce((acc: any, upload) => {
    acc[upload.file_type] = {
      count: (acc[upload.file_type]?.count || 0) + 1,
      totalSize: (acc[upload.file_type]?.totalSize || 0) + upload.file_size
    };
    return acc;
  }, {}) || {};

  const totalSize = uploadsByType?.reduce((sum, upload) => sum + upload.file_size, 0) || 0;

  // Get recent uploads (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { count: recentUploads } = await supabaseAdmin
    .from('uploads')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', thirtyDaysAgo.toISOString());

  res.json({
    success: true,
    stats: {
      totalUploads: totalUploads || 0,
      totalSize,
      recentUploads: recentUploads || 0,
      typeBreakdown: typeStats
    }
  });
}));

export default router;