import { supabaseAdmin } from '../config/supabase';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Migration script to update existing users' sports categories
 * This script updates all existing data to use only the three allowed sports categories:
 * 'Coco', 'Martial Arts', and 'Calorie Fight'
 */
export async function migrateSportsCategories() {
  try {
    console.log('Starting sports categories migration...');
    
    // Read the SQL migration file
    const migrationPath = join(__dirname, '../../database/migrate_sports_categories.sql');
    const migrationSQL = readFileSync(migrationPath, 'utf8');
    
    // Split the SQL into individual statements (excluding comments and empty lines)
    const statements = migrationSQL
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt && !stmt.startsWith('--') && stmt !== 'BEGIN' && stmt !== 'COMMIT');
    
    console.log(`Executing ${statements.length} migration statements...`);
    
    // Execute each statement
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (!statement) continue;
      
      console.log(`Executing statement ${i + 1}/${statements.length}...`);
      
      const { error } = await supabaseAdmin.rpc('exec_sql', {
        sql: statement
      });
      
      if (error) {
        console.error(`Error executing statement ${i + 1}:`, error);
        console.error('Statement:', statement);
        throw error;
      }
    }
    
    console.log('Migration completed successfully!');
    
    // Run verification queries
    console.log('\nRunning verification queries...');
    
    // Check users sports categories
    const { data: userCategories } = await supabaseAdmin
      .rpc('exec_sql', {
        sql: "SELECT DISTINCT unnest(sports_categories) as category FROM users WHERE sports_categories IS NOT NULL AND array_length(sports_categories, 1) > 0"
      });
    console.log('User sports categories:', userCategories);
    
    // Check posts sports categories
    const { data: postCategories } = await supabaseAdmin
      .rpc('exec_sql', {
        sql: "SELECT DISTINCT sports_category FROM posts WHERE sports_category IS NOT NULL"
      });
    console.log('Post sports categories:', postCategories);
    
    // Check sports_categories table
    const { data: sportsCategories } = await supabaseAdmin
      .from('sports_categories')
      .select('name')
      .order('name');
    console.log('Available sports categories:', sportsCategories?.map(c => c.name));
    
    return {
      success: true,
      message: 'Sports categories migration completed successfully',
      userCategories,
      postCategories,
      sportsCategories: sportsCategories?.map(c => c.name) || []
    };
    
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
}

/**
 * Rollback function (if needed)
 * This would restore the original sports categories
 */
export async function rollbackSportsCategories() {
  console.log('Rollback functionality not implemented. Please restore from database backup if needed.');
  throw new Error('Rollback not implemented - restore from backup');
}

// CLI execution
if (require.main === module) {
  migrateSportsCategories()
    .then((result) => {
      console.log('\nMigration Result:', result);
      process.exit(0);
    })
    .catch((error) => {
      console.error('\nMigration failed:', error);
      process.exit(1);
    });
}