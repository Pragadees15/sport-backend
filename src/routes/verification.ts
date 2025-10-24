import express, { Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { supabase as supabaseClient } from '../server';

const router = express.Router();

// Create a verification request (aspirant or coach)
router.post('/requests', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { role, notes } = req.body as { role: 'aspirant' | 'coach'; notes?: string };

    if (!['aspirant', 'coach'].includes(role)) {
      res.status(400).json({ error: 'Invalid role for verification' });
      return;
    }

    const { data, error } = await supabaseClient
      .from('verification_requests')
      .upsert({ user_id: user.id, role, status: 'pending', notes })
      .select('*')
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ request: data });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to create verification request' });
  }
});

// Upload a document mapped to a verification request
router.post('/requests/:requestId/documents', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { requestId } = req.params;
    const { fileUrl, fileName, documentType } = req.body as { fileUrl: string; fileName: string; documentType: string };

    if (!fileUrl || !fileName || !documentType) {
      res.status(400).json({ error: 'fileUrl, fileName and documentType are required' });
      return;
    }

    // Ensure request belongs to the user
    const { data: reqRow, error: reqErr } = await supabaseClient
      .from('verification_requests')
      .select('id, user_id')
      .eq('id', requestId)
      .single();

    if (reqErr || !reqRow || reqRow.user_id !== user.id) {
      res.status(404).json({ error: 'Verification request not found' });
      return;
    }

    const { data, error } = await supabaseClient
      .from('verification_documents')
      .insert({ request_id: requestId, user_id: user.id, file_url: fileUrl, file_name: fileName, document_type: documentType })
      .select('*')
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ document: data });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

// Get my verification requests with documents
router.get('/my', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { data: requests, error } = await supabaseClient
      .from('verification_requests')
      .select('*, documents:verification_documents(*)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ requests: requests ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to fetch verification status' });
  }
});

// List pending requests for review (admin sees all; coach sees only aspirants)
router.get('/pending', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user as { id: string; role: string };

    if (!['admin', 'administrator', 'coach'].includes(user.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const query = supabaseClient
      .from('verification_requests')
      .select('*, user:users!verification_requests_user_id_fkey(id, email, name, username, role, avatar_url), documents:verification_documents(*)')
      .eq('status', 'pending');

    if (user.role === 'coach') {
      (query as any).eq('role', 'aspirant');
    }

    const { data, error } = await (query as any).order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ requests: data ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to fetch pending requests' });
  }
});

// List approved requests for review management (admin/administrator sees all; coach sees only aspirants)
router.get('/approved', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user as { id: string; role: string };

    if (!['admin', 'administrator', 'coach'].includes(user.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const query = supabaseClient
      .from('verification_requests')
      .select('*, user:users!verification_requests_user_id_fkey(id, email, name, username, role, avatar_url), documents:verification_documents(*)')
      .eq('status', 'approved')
      .order('reviewed_at', { ascending: false });

    if (user.role === 'coach') {
      (query as any).eq('role', 'aspirant');
    }

    const { data, error } = await (query as any);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ requests: data ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to fetch approved requests' });
  }
});

// List rejected requests (admin/administrator sees all; coach sees only aspirants)
router.get('/rejected', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user as { id: string; role: string };

    if (!['admin', 'administrator', 'coach'].includes(user.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const query = supabaseClient
      .from('verification_requests')
      .select('*, user:users!verification_requests_user_id_fkey(id, email, name, username, role, avatar_url), documents:verification_documents(*)')
      .eq('status', 'rejected')
      .order('reviewed_at', { ascending: false });

    if (user.role === 'coach') {
      (query as any).eq('role', 'aspirant');
    }

    const { data, error } = await (query as any);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ requests: data ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to fetch rejected requests' });
  }
});

// Approve/Reject a request
router.post('/requests/:id/review', authenticateToken, async (req: Request, res: Response) => {
  try {
    const reviewer = (req as any).user as { id: string; role: string };
    const { id } = req.params;
    const { status, notes } = req.body as { status: 'approved' | 'rejected'; notes?: string };

    if (!['admin', 'administrator', 'coach'].includes(reviewer.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const { data: requestRow, error: fetchErr } = await supabaseClient
      .from('verification_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !requestRow) {
      res.status(404).json({ error: 'Verification request not found' });
      return;
    }

    if (reviewer.role === 'coach' && requestRow.role !== 'aspirant') {
      res.status(403).json({ error: 'Coaches can only review aspirants' });
      return;
    }

    const { data: updated, error: updErr } = await supabaseClient
      .from('verification_requests')
      .update({ status, notes, reviewed_by: reviewer.id, reviewed_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();

    if (updErr) {
      res.status(500).json({ error: updErr.message });
      return;
    }

    if (status === 'approved') {
      await supabaseClient
        .from('users')
        .update({ is_verified: true })
        .eq('id', requestRow.user_id);
    }

    res.json({ request: updated });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to review verification request' });
  }
});

// De-verify a user and reset a request to pending (admin/administrator only)
router.post('/requests/:id/deverify', authenticateToken, async (req: Request, res: Response) => {
  try {
    const reviewer = (req as any).user as { id: string; role: string };
    const { id } = req.params;

    if (!['admin', 'administrator'].includes(reviewer.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const { data: requestRow, error: fetchErr } = await supabaseClient
      .from('verification_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !requestRow) {
      res.status(404).json({ error: 'Verification request not found' });
      return;
    }

    // Set user as not verified
    await supabaseClient
      .from('users')
      .update({ is_verified: false })
      .eq('id', requestRow.user_id);

    // Reset request back to pending
    const { data: updated, error: updErr } = await supabaseClient
      .from('verification_requests')
      .update({ status: 'pending', reviewed_by: null, reviewed_at: null })
      .eq('id', id)
      .select('*')
      .single();

    if (updErr) {
      res.status(500).json({ error: updErr.message });
      return;
    }

    res.json({ request: updated });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to reset verification status' });
  }
});

export default router;


