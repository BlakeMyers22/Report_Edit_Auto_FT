/************************************************
 * netlify/functions/store-training-data.js
 ************************************************/
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

/**
 * We'll read our Supabase URL and Service Role Key from environment variables.
 * Make sure you added these in Netlify settings:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase credentials. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
}

// Initialize the Supabase client with the service role key
const supabase = createClient(supabaseUrl, supabaseServiceKey);

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
    // Parse the body we expect:
    // {
    //   "finalReportText": "string with the entire final assembled text",
    //   "ratings": { "introduction": 9, "authorization": 9, ... },
    //   "metadata": { ...anything else e.g. user info, date, etc. }
    // }
    const { finalReportText, ratings, metadata } = JSON.parse(event.body || '{}');

    if (!finalReportText || !ratings) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Missing finalReportText or ratings in request body.'
        })
      };
    }

    // Check if all ratings >= 9
    const allSections = Object.keys(ratings);
    if (allSections.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'No sections in ratings.'
        })
      };
    }

    const allAboveNine = allSections.every(section => {
      const val = Number(ratings[section]);
      return !isNaN(val) && val >= 9;
    });

    if (!allAboveNine) {
      // If not all sections >= 9, do nothing special
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: 'Report not stored because not all ratings are >= 9.'
        })
      };
    }

    // If we're here, user rated all sections >= 9
    // Insert into training_data table as JSON
    // We'll store finalReportText plus any metadata you want.
    // For advanced GPT-4 fine-tuning, you might eventually want to
    // store it in a more complex "messages" array format.
    const insertPayload = {
      report_json: {
        text: finalReportText,
        ratings,
        metadata
      }
    };

    const { data, error } = await supabase
      .from('training_data')
      .insert([insertPayload]);

    if (error) {
      console.error('Supabase insert error:', error);
      throw new Error('Failed to insert training data into Supabase.');
    }

    // Now let's see how many total entries we have
    const { count, error: countError } = await supabase
      .from('training_data')
      .select('*', { count: 'exact', head: true });

    if (countError) {
      console.error('Supabase count error:', countError);
      throw new Error('Failed to count training_data rows.');
    }

    // If count is a multiple of 5, let's trigger fine-tuning
    if (count % 5 === 0 && count > 0) {
      console.log(`We have ${count} training records. Triggering fine-tune...`);

      // We can call the fine-tune function
      // (Make sure your "fine-tune" function is at /.netlify/functions/fine-tune)
      try {
        const fineTuneResponse = await axios.post(`${process.env.URL}/.netlify/functions/fine-tune`, {
          // We could pass some data if needed, e.g. a "trigger" param
          trigger: `Auto fine-tune at ${count} records`
        }, {
          headers: { 'Content-Type': 'application/json' }
        });
        console.log('fineTuneResponse:', fineTuneResponse.data);
      } catch (fineTuneErr) {
        console.error('Error triggering fine-tune:', fineTuneErr);
        // We won't throw an error because we still want to return a success for storing the data
      }
    }

    // Return success
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'Successfully stored training data (all ratings >= 9).'
      })
    };
  } catch (error) {
    console.error('Error in store-training-data function:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to store training data',
        details: error.message
      })
    };
  }
};

