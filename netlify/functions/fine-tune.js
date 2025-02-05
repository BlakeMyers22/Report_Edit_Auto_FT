/************************************************
 * netlify/functions/fine-tune.js
 ************************************************/
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

/**
 * We'll read our Supabase URL and Service Role Key from environment variables,
 * and also OPENAI_API_KEY from environment variables.
 */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openAiKey = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !supabaseServiceKey || !openAiKey) {
  console.error('Missing one of SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or OPENAI_API_KEY.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Initialize the OpenAI client
const openai = new OpenAI({
  apiKey: openAiKey
});

/**
 * This function:
 * 1) Fetches all rows from `training_data`.
 * 2) Converts them into .jsonl lines in chat fine-tuning format.
 * 3) Uploads the file to OpenAI.
 * 4) Creates the GPT-4 fine-tuning job (no waiting).
 * 5) Stores the jobId in `app_settings` as `current_finetune_job_id`.
 * 6) Returns quickly.
 */
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  try {
    // Step 1: Fetch all training_data rows
    const { data: rows, error: fetchError } = await supabase
      .from('training_data')
      .select('report_json')
      .order('created_at', { ascending: true });

    if (fetchError) {
      console.error('Error fetching training_data rows:', fetchError);
      throw new Error('Could not retrieve training data from Supabase.');
    }

    if (!rows || rows.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'No training data found. Nothing to fine-tune.' })
      };
    }

    // Build .jsonl lines in GPT-4 chat format
    const lines = rows.map((r) => {
      const finalText = r.report_json?.text || '';
      return JSON.stringify({
        messages: [
          {
            role: 'system',
            content: 'You are a specialized forensic report generator. Provide thorough, professional, consistent content.'
          },
          {
            role: 'user',
            content: 'Generate a complete forensic engineering report based on the user’s inputs and data.'
          },
          {
            role: 'assistant',
            content: finalText
          }
        ]
      });
    });
    const jsonlContent = lines.join('\n');

    // Write to a temporary file in /tmp
    const tempFileName = `/tmp/fine-tune-${uuidv4()}.jsonl`;
    fs.writeFileSync(tempFileName, jsonlContent, 'utf-8');

    // Upload the file to OpenAI
    const fileUpload = await openai.files.create({
      file: fs.createReadStream(tempFileName),
      purpose: 'fine-tune'
    });
    const openAIFileId = fileUpload.id;
    console.log('Uploaded file to OpenAI with ID:', openAIFileId);

    // Create the fine-tuning job for GPT-4
    const fineTune = await openai.fineTuning.jobs.create({
      model: 'gpt-4o-2024-08-06',
      training_file: openAIFileId
    });
    console.log('Fine-tune job created (async):', fineTune);

    // We have an ID for the job:
    const fineTuneId = fineTune.id;

    // Step 2: Store it in Supabase's app_settings so we can check status later
    // We'll keep a separate key for job ID so we don't overwrite the active_finetuned_model.
    const { error: upsertError } = await supabase
      .from('app_settings')
      .upsert({
        key: 'current_finetune_job_id',
        value: fineTuneId
      }, { onConflict: 'key' });

    if (upsertError) {
      console.error('Error storing current_finetune_job_id in app_settings:', upsertError);
    }

    // Optional: also set a "finetune_in_progress" or something similar
    await supabase
      .from('app_settings')
      .upsert({
        key: 'finetune_in_progress',
        value: 'true'
      }, { onConflict: 'key' });

    // Clean up temp file
    try {
      fs.unlinkSync(tempFileName);
    } catch (cleanupErr) {
      console.warn('Failed to delete temp file:', cleanupErr);
    }

    // Return quickly, telling the user the job was started
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'Fine-tune job started. Check the job status function to see when it finishes.',
        fineTuneId
      })
    };
  } catch (error) {
    console.error('Error in fine-tune (async) function:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to start GPT-4 fine-tune job',
        details: error.message
      })
    };
  }
};

