/************************************************
 * netlify/functions/generate-report.js
 ************************************************/
const OpenAI = require('openai');
const axios = require('axios');
// NEW OR MODIFIED: import and init Supabase
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for generate-report.');
}
const supabase = createClient(supabaseUrl, supabaseServiceKey);

/**
 * Initialize OpenAI with your API key.
 * (Removed the old 'chatgpt-4o-latest' reference)
 */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Utility function: Safely convert a value to a string,
 * returning fallback if it's null/undefined or empty.
 */
function safeString(value, fallback = '') {
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }
  return fallback;
}

/**
 * Utility function: Safely join an array. If it's not a valid array
 * or it's empty, return an empty string.
 */
function safeArrayJoin(arr, separator = ', ') {
  if (Array.isArray(arr) && arr.length > 0) {
    return arr.join(separator);
  }
  return '';
}

/**
 * Utility function: Safely parse a date.
 * If parsing fails or the input is missing, return null.
 */
function safeParseDate(dateString) {
  if (!dateString) return null;
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return null;
  return d;
}

/**
 * Fetch historical weather data with safe checks.
 * If the date is in the future or unavailable, we handle that gracefully.
 */
// async function getWeatherData(location, dateString) {
//   try {
//     if (!location || !dateString) {
//       return { success: true, data: {} };
//     }
//     const dateObj = safeParseDate(dateString);
//     if (!dateObj) {
//       return { success: true, data: {} };
//     }

//     // If the date is after "today", skip or note it.
//     const today = new Date();
//     if (dateObj > today) {
//       return {
//         success: true,
//         data: {
//           note: `Weather data not found for a future date: ${dateObj.toISOString().split('T')[0]}`
//         }
//       };
//     }

//     const formattedDate = dateObj.toISOString().split('T')[0];

//     // Attempt call to WeatherAPI
//     const response = await axios.get('http://api.weatherapi.com/v1/history.json', {
//       params: {
//         key: process.env.WEATHER_API_KEY,
//         q: location,
//         dt: formattedDate
//       }
//     });

//     const dayData = response.data.forecast.forecastday[0].day;
//     const hourlyData = response.data.forecast.forecastday[0].hour;
//     const maxWindGust = Math.max(...hourlyData.map(hour => hour.gust_mph));
//     const maxWindTime = hourlyData.find(hour => hour.gust_mph === maxWindGust)?.time || '';

//     return {
//       success: true,
//       data: {
//         maxTemp: `${dayData.maxtemp_f}°F`,
//         minTemp: `${dayData.mintemp_f}°F`,
//         avgTemp: `${dayData.avgtemp_f}°F`,
//         maxWindGust: `${maxWindGust} mph`,
//         totalPrecip: `${dayData.totalprecip_in} inches`,
//         humidity: `${dayData.avghumidity}%`,
//         conditions: dayData.condition.text,
//         hailPossible: dayData.condition.text.toLowerCase().includes('hail') ? 'Yes' : 'No',
//         thunderstorm: dayData.condition.text.toLowerCase().includes('thunder') ? 'Yes' : 'No'
//       }
//     };
//   } catch (error) {
//     console.error('Weather API Error:', error);
//     return { success: false, error: error.message };
//   }
// }

/**
 * Function to approximate latitude/longitude offsets for a given mile radius.
 * 1 degree of latitude ≈ 69 miles
 * 1 degree of longitude ≈ varies (near the equator it's ~69 miles, but less at higher latitudes)
 */

/**
 * Function to approximate latitude/longitude offsets for a given mile radius.
 * 1 degree of latitude ≈ 69 miles
 * 1 degree of longitude ≈ varies (near the equator it's ~69 miles, but less at higher latitudes)
 */
function getBoundingCoordinates(lat, lon, radiusMiles = 50) {
  const latOffset = radiusMiles / 69;
  const lonOffset = radiusMiles / (69 * Math.cos(lat * (Math.PI / 180))); // Adjust for longitude compression at higher latitudes

  return {
    minLat: lat - latOffset,
    maxLat: lat + latOffset,
    minLon: lon - lonOffset,
    maxLon: lon + lonOffset
  };
}

/**
 * Fetch weather data from Visual Crossing within a 50-mile radius.
 */
async function getWeatherData(location, dateString) {
  try {
    if (!location || !dateString) {
      return { success: true, data: {} };
    }

    const dateObj = safeParseDate(dateString);
    if (!dateObj) {
      return { success: true, data: {} };
    }

    // If the date is in the future, handle it gracefully
    const today = new Date();
    if (dateObj > today) {
      return {
        success: true,
        data: {
          note: `Weather data not found for a future date: ${dateObj.toISOString().split('T')[0]}`
        }
      };
    }

    const formattedDate = dateObj.toISOString().split('T')[0];

    // Step 1: Get Lat/Lon of the location
    const geoResponse = await axios.get(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(location)}.json`, {
      params: {
        access_token: process.env.MAPBOX_API_KEY // Use Mapbox or any geolocation API to resolve coordinates
      }
    });

    if (!geoResponse.data.features.length) {
      throw new Error('Invalid location.');
    }

    const { center } = geoResponse.data.features[0]; // [lon, lat]
    const lon = center[0];
    const lat = center[1];

    // Step 2: Compute bounding box
    const { minLat, maxLat, minLon, maxLon } = getBoundingCoordinates(lat, lon, 50);

    // Step 3: Fetch weather data for multiple locations in this bounding box
    const response = await axios.get(`https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/weatherdata/history`, {
      params: {
        aggregateHours: 24,  
        contentType: 'json',
        unitGroup: 'us',
        key: process.env.WEATHER_API_KEY,
        location: `${lat},${lon}`,
        startDateTime: formattedDate,
        endDateTime: formattedDate
      }
    });

    // Extract relevant weather data
    const weatherData = response.data.locations[Object.keys(response.data.locations)[0]].values[0];

    let result = {};

    // Always report rain if present
    if (weatherData.precip > 0) {
      result.precipitationType = "Rain";
      result.totalPrecip = `${weatherData.precip} inches`;
    }

    // Always report snow if present
    if (weatherData.snow !== undefined && weatherData.snow > 0) {
      result.precipitationType = "Snow";
      result.snowAmount = `${weatherData.snow} inches`;
    }

    // Always report hail if present
    if (weatherData.hail !== undefined) {
      result.precipitationType = "Hail";
      if (weatherData.hail > 0) {
        result.hailSize = `${weatherData.hail} inches`;
      }
    }

    // Include other key weather metrics
    result.maxTemp = `${weatherData.maxt}°F`;
    result.minTemp = `${weatherData.mint}°F`;
    result.avgTemp = `${weatherData.temp}°F`;
    result.maxWindGust = `${weatherData.wgust} mph`;
    result.humidity = `${weatherData.humidity}%`;
    result.conditions = weatherData.conditions;

    return {
      success: true,
      data: result
    };

  } catch (error) {
    console.error('Visual Crossing API Error:', error);
    return { success: false, error: error.message };
  }
}





/**
 * Build the prompt for each section, making sure we avoid
 * placeholders, contradictory roof info, multi-story references
 * if it's a single story, etc.
 */
async function generateSectionPrompt(sectionName, context, weatherData, customInstructions = '') {
  // Extract fields
  const investigationDate   = safeString(context?.investigationDate);
  const dateOfLoss          = safeString(context?.dateOfLoss);
  const claimTypeString     = safeArrayJoin(context?.claimType);
  const propertyType        = safeString(context?.propertyType);
  const propertyAge         = safeString(context?.propertyAge);
  const constructionType    = safeString(context?.constructionType);
  const currentUse          = safeString(context?.currentUse);
  const squareFootage       = safeString(context?.squareFootage);
  const address             = safeString(context?.address);
  const engineerName        = safeString(context?.engineerName);
  const engineerEmail       = safeString(context?.engineerEmail);
  const engineerLicense     = safeString(context?.engineerLicense);
  const engineerPhone       = safeString(context?.engineerPhone);
  const propertyOwnerName   = safeString(context?.propertyOwnerName);
  const projectName         = safeString(context?.projectName);

  // Affected areas
  const affectedAreas       = safeArrayJoin(context?.affectedAreas);
  const engineerNotes       = safeString(context?.engineerNotes);

  // Summarize roof types from checkboxes
  let roofTypesDetected = '';
  if (context?.roofMetalChecked) {
    roofTypesDetected += 'Metal, ';
  }
  if (context?.roofCompChecked) {
    roofTypesDetected += 'Composition Shingles, ';
  }
  if (context?.roofSinglePlyChecked) {
    roofTypesDetected += 'Single-Ply Membrane, ';
  }
  if (context?.roofModBitChecked) {
    roofTypesDetected += 'Modified Bitumen, ';
  }
  if (context?.roofBURChecked) {
    roofTypesDetected += 'Built Up Roofing (Gravel Ballast), ';
  }
  if (context?.roofClayTileChecked) {
    roofTypesDetected += 'Clay Tile, ';
  }
  if (context?.roofConcreteTileChecked) {
    roofTypesDetected += 'Concrete Tile, ';
  }
  // remove trailing comma
  roofTypesDetected = roofTypesDetected.replace(/,\s*$/, '');

  // Weather data
  let weatherSummary = '';
  if (weatherData?.note) {
    weatherSummary = `Weather Data Note: ${weatherData.note}`;
  } else if (Object.keys(weatherData || {}).length > 0) {
    weatherSummary = JSON.stringify(weatherData, null, 2);
  }

  // Large system instruction
  const bigSystemInstruction = `
You are an expert forensic engineer generating professional report sections. 
Use only the data from user inputs; do not invent details that contradict them.
Utilize the engineer inputs and create sound, detailed, and objective arguments in defense of substantiating the claim.

Guidelines:
1. Use formal, technical language
2. Include specific context details
3. Maintain logical flow
4. Support conclusions with evidence
5. Reference documentation appropriately
6. Use unique phrasing
7. Ensure completeness
8. Incorporate custom instructions while maintaining standards
9. Make it so that each section is as long and detailed as possible.
10. Make all the formatting uniform, with all the main headings the same font in bold, and all the rest of the text smaller font.
11. Utilize the engineer inputs and create sound, detailed, and objective arguments in defense of substantiating the claim.
12. Be lenghty and detailed throughout.

Key points:
1. Do NOT invent roofing types if user only specifies certain categories.
2. Do NOT mention multiple floors if user has not indicated that (avoid referencing an upper floor if not specified).
3. Keep Date of Loss (${dateOfLoss}) separate from Inspection Date (${investigationDate}).
4. If weather data is missing or the date was in the future, note that briefly rather than printing "N/A".
5. Avoid placeholders like [e.g., ...], [Third Party], etc.
6. The user’s claim types: ${claimTypeString}.
7. The indicated roof categories: ${roofTypesDetected}.
8. The property address: ${address}.
9. The property owner (or project name): ${propertyOwnerName} / ${projectName}.
10. The building type: ${propertyType}, age: ${propertyAge}, use: ${currentUse}, sq ft: ${squareFootage}.
11. Weather Data Summary: ${weatherSummary}
`;

  const basePrompts = {
    introduction: `
You are writing the "Introduction" for a forensic engineering report.
- Address: ${address}
- Date of Loss: ${dateOfLoss}
- Investigation Date: ${investigationDate}
- Claim Type(s): ${claimTypeString}
Explain the purpose of the inspection.
Do not add contradictory roofing details.
Do not mention the lack or absence of any data. Only mention things on data or inputs that you have.
`,

    authorization: `
You are writing the "Authorization and Scope" section.
Include:
1) Who authorized it (e.g., property owner or law firm).
2) The scope of work (site visit, photos, etc.).
3) Summarize major tasks.
Do not repeat details if aleardy in a previous section, such as the property address and the property owner.
Do not make anything up or say anything that cannot be directly inferred from the inputs you have.
Do not mention the lack or absence of any data. Only mention things on data or inputs that you have
`,

    background: `
You are writing "Background Information."
Include relevant details:
- Property Type: ${propertyType}
- Age: ${propertyAge}
- Construction Type: ${constructionType}
- Current Use: ${currentUse}
- Square Footage: ${squareFootage}
No placeholders or contradictory info.
Do not repeat details if aleardy in a previous section, such as the property address and the property owner.
Do not mention the lack or absence of any data. Only mention things on data or inputs that you have.
`,

    observations: `
You are writing "Site Observations and Analysis."
Affected areas: ${engineerNotes}.
Roof categories indicated: ${roofTypesDetected}.
Claim type(s): ${claimTypeString}.

Only mention what the user indicated in the Engineer Notes.
Do not repeat details if aleardy in a previous section, such as the property address and the property owner.
Do not say that the engineer inspected something (e.g., interior) unless explicity said in the Engineer Notes.
Do not go beyond what is directly given in the Engineer Notes inputs.
Do not mention the lack or absence of any data. Only mention things on inputs in Engineer Notes.
`,

    moisture: `
"Survey" (Moisture) section.
Affected areas: ${engineerNotes}.
Do not mention anything that is not directly given in the engineering inputs.
Do not repeat details if aleardy in a previous section, such as the property address and the property owner.
Do not mention the absence of any information or data.
Ensure the data is always objective and specific leaving zero holes to argue against our engineer claims.
`,

    meteorologist: `
"Meteorologist Report" section.
Data: ${weatherSummary}.
Engineer Notes: ${engineerNotes}.
Do not repeat too much from the Engineer Notes that has already been mentioned in previous sections.
Do not repeat details if aleardy in a previous section, such as the property address and the property owner.
Use only weather information that does not contradict the inputs from the engineer.
Use weather information to support Engineer claims.
Do not talk about lack of evidence about any weather data.
Don't mention the engineer. You are him.
`,

    conclusions: `
"Conclusions and Recommendations."
Summarize your final opinion on cause(s) of loss. 
Propose next steps or repairs if relevant.
Ensure this remains sound, objective, factual and always based on legitimate observations inputted by the engineer.
Don't mention the engineer. You are him.
`,

    rebuttal: `
"Rebuttal" section.
Engineer Notes: ${engineerNotes}.
Keep in as close allignment as possible to what the engineer has said in the input.
Do not mention the lack of any weather data.
Do not repeat details if aleardy in a previous section, such as the property address and the property owner.
Use only weather information that does not contradict the inputs from the engineer.
Use weather information only to support Engineer claims.
Don't mention the engineer. You are him.
`,

    limitations: `
"Limitations" section.
Typical disclaimers about data reliance, scope boundaries, site access, etc.
No placeholders.
Do not repeat details if aleardy in a previous section, such as the property address and the property owner.
Ensure the output here never contradicts itself or any other part of the report. 
`,

    tableofcontents: `
You are writing the "Table of Contents" section. Follow these formatting rules precisely:

1) Print "**Table of Contents**" (in bold) on a line by itself.
2) Then each section name on its own line, with a bullet point.
3) The final text should look like this (with line breaks and bullet points for each of the section names):

**Table of Contents**
Opening Letter
Introduction
Authorization and Scope
Background Information
Site Observations and Analysis
Survey
Meteorologist Report
Conclusions and Recommendations
Rebuttal
Limitations

No extra words, no additional punctuation, and exactly one section name per line.
`,

    openingletter: `
"Opening Letter" for the final report.
Include:
- Date of Loss: ${dateOfLoss}
- Investigation Date: ${investigationDate}
- Claim Type(s): ${claimTypeString}
- Address: ${address}
- Brief greeting
- Signature block: ${engineerName}, License: ${engineerLicense}, Email: ${engineerEmail}, Phone: ${engineerPhone}
`
  };

  const normalizedSection = (sectionName || '').trim().toLowerCase();
  const fallbackPrompt = `Write a professional section: ${sectionName}, using only user inputs.`;

  const basePrompt = basePrompts[normalizedSection] || fallbackPrompt;

  const safeCustom = safeString(customInstructions, '');
  const finalPrompt = safeCustom 
    ? `${basePrompt}\n\nAdditional instructions:\n${safeCustom}`
    : basePrompt;

  // Merge with big system instructions
  const fullPrompt = `
${bigSystemInstruction}

Now produce the "${sectionName}" section.

${finalPrompt}
`;

  return fullPrompt;
}

// NEW OR MODIFIED: a helper function to get the currently active fine-tuned model from Supabase
async function getActiveModel() {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'active_finetuned_model')
      .single();

    if (error) {
      console.error('Supabase error fetching active_finetuned_model:', error);
      return null; // fallback will be used
    }
    return data?.value || null;
  } catch (err) {
    console.error('Error retrieving active_finetuned_model:', err);
    return null;
  }
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  try {
    const { section, context: userContext, customInstructions } = JSON.parse(event.body) || {};

    // Weather data fetch, skip for tableOfContents, openingLetter, introduction
    let weatherResult = { success: true, data: {} };
    const lowerSection = (section || '').trim().toLowerCase();

    if (!['tableofcontents', 'openingletter', 'introduction'].includes(lowerSection)) {
      const dateObj = safeParseDate(userContext?.dateOfLoss);
      if (dateObj && userContext?.address) {
        // Attempt weather call
        weatherResult = await getWeatherData(userContext.address, dateObj.toISOString().split('T')[0]);
      }
    }

    // Build prompt
    const prompt = await generateSectionPrompt(section, userContext, weatherResult.data, customInstructions);

    // NEW OR MODIFIED: fetch the current model from Supabase
    let activeModel = await getActiveModel();
    if (!activeModel) {
      // fallback if none is set
      activeModel = 'gpt-4o-2024-08-06';
    }

    // Create chat completion using the dynamic model
    const completion = await openai.chat.completions.create({
      model: activeModel,
      messages: [
        {
          role: 'system',
          content: prompt
        }
      ],
      temperature: 0.2, // reduce "creative" contradictions
      max_tokens: 4000
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        section: completion.choices[0].message.content || '',
        sectionName: section,
        weatherData: weatherResult.data
      })
    };
  } catch (error) {
    console.error('Error in generate-report function:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to generate report section',
        details: error.message
      })
    };
  }
};

