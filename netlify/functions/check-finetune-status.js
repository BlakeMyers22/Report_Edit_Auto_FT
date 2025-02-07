/************************************************
 * netlify/functions/check-finetune-status.js
 ************************************************/
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openAiKey = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !supabaseServiceKey || !openAiKey) {
  console.error('Missing one of SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or OPENAI_API_KEY.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const openai = new OpenAI({ apiKey: openAiKey });

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  try {
    // Use maybeSingle() so missing row won't cause an error
    const { data: jobRow, error: jobRowError } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'current_finetune_job_id')
      .maybeSingle();

    // If there's a real DB error (like connection issues)
    if (jobRowError) {
      console.error('Error fetching current_finetune_job_id:', jobRowError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Cannot fetch current fine-tune job ID',
          details: jobRowError.message
        })
      };
    }

    // If no row was found, jobRow == null
    if (!jobRow) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: 'No fine-tune job currently in progress.'
        })
      };
    }

    // jobRow was found, so let's retrieve job status from OpenAI
    const jobId = jobRow.value;
    const jobInfo = await openai.fineTuning.jobs.retrieve(jobId);
    console.log('Retrieved job info:', jobInfo);
    const jobStatus = jobInfo.status;

    if (jobStatus === 'succeeded') {
      // We have a new model name
      const newModelName = jobInfo.fine_tuned_model;
      console.log('Fine-tune job succeeded. New model is:', newModelName);

      // Update active_finetuned_model in Supabase
      if (newModelName) {
        const { error: updateModelError } = await supabase
          .from('app_settings')
          .upsert({
            key: 'active_finetuned_model',
            value: newModelName
          }, { onConflict: 'key' });

        if (updateModelError) {
          console.error('Error updating active_finetuned_model:', updateModelError);
        }
      }

      // Clear the job ID or set finetune_in_progress = false
      await supabase
        .from('app_settings')
        .delete()
        .eq('key', 'current_finetune_job_id');

      await supabase
        .from('app_settings')
        .upsert({
          key: 'finetune_in_progress',
          value: 'false'
        }, { onConflict: 'key' });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: `Fine-tune succeeded. Model = ${newModelName}`,
          status: jobStatus
        })
      };
    } else if (jobStatus === 'failed') {
      console.error('Fine-tune job failed:', jobInfo);

      await supabase
        .from('app_settings')
        .delete()
        .eq('key', 'current_finetune_job_id');

      await supabase
        .from('app_settings')
        .upsert({
          key: 'finetune_in_progress',
          value: 'false'
        }, { onConflict: 'key' });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: 'Fine-tune job failed. ID cleared.',
          status: jobStatus
        })
      };
    } else {
      // still running or queued
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: `Job status = ${jobStatus}. Still in progress.`,
          status: jobStatus
        })
      };
    }
  } catch (error) {
    console.error('Error checking fine-tune status:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to check fine-tune status',
        details: error.message
      })
    };
  }
};
