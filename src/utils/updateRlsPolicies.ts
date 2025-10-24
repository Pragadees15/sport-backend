import { supabase } from '../config/supabase';

/**
 * Update RLS policies for safe_locations table
 * This fixes the issue where only verified users could create safe locations
 */
export async function updateRlsPolicies() {
  try {
    console.log('Updating RLS policies for safe_locations table...');
    
    // Drop the old policy
    const { error: dropError } = await supabase.rpc('exec_sql', {
      sql: 'DROP POLICY IF EXISTS "Verified users can manage safe locations" ON safe_locations;'
    });
    
    if (dropError) {
      console.error('Error dropping old policy:', dropError);
    } else {
      console.log('Old policy dropped successfully');
    }
    
    // Create new policies
    const policies = [
      {
        name: 'Authenticated users can create safe locations',
        sql: `CREATE POLICY "Authenticated users can create safe locations" ON safe_locations
               FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);`
      },
      {
        name: 'Users can update safe locations',
        sql: `CREATE POLICY "Users can update safe locations" ON safe_locations
               FOR UPDATE USING (
                   created_by = auth.uid() OR 
                   EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND is_verified = true)
               );`
      },
      {
        name: 'Users can delete safe locations',
        sql: `CREATE POLICY "Users can delete safe locations" ON safe_locations
               FOR DELETE USING (
                   created_by = auth.uid() OR 
                   EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND is_verified = true)
               );`
      }
    ];
    
    for (const policy of policies) {
      const { error } = await supabase.rpc('exec_sql', {
        sql: policy.sql
      });
      
      if (error) {
        console.error(`Error creating policy "${policy.name}":`, error);
      } else {
        console.log(`Policy "${policy.name}" created successfully`);
      }
    }
    
    console.log('RLS policies update completed');
    
  } catch (error) {
    console.error('Error updating RLS policies:', error);
  }
}

// Run the update if this file is executed directly
if (require.main === module) {
  updateRlsPolicies();
}