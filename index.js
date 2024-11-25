const express = require('express');
const bodyParser = require('body-parser');
const { twiml } = require('twilio');
const path = require('path');
const axios = require('axios');
const cors = require('cors');
const { IamAuthenticator } = require('ibm-watson/auth');
const SpeechToTextV1 = require('ibm-watson/speech-to-text/v1');
const twilio = require('twilio');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Configure middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cors());
app.use(express.json());

require('dotenv').config();

// Watson configuration
const speechToText = new SpeechToTextV1({
  authenticator: new IamAuthenticator({
    apikey: process.env.watson_speech_to_text_api_key,
  }),
  serviceUrl: process.env.watson_speech_to_text_url,
});

// Twilio configuration
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const ACCESS_TOKEN = process.env.access_token;

// Store calls and conversations in memory
app.locals.currentCall = null;
app.locals.pastCalls = [];
app.locals.conversations = [];
app.locals.pastConversations = [];

// Root endpoint
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Download conversation endpoint
app.get('/download-conversation/:callSid', (req, res) => {
  const callSid = req.params.callSid;
  const call = app.locals.pastCalls.find(c => c.callSid === callSid);

  if (!call || !call.conversations) {
    return res.status(404).send('Conversation not found');
  }

  const conversationText = call.conversations.map(conv => 
    `User: ${conv.user}\nBot: ${conv.bot}\n---\n`
  ).join('');

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename=conversation_${callSid}.txt`);
  res.send(conversationText);
});

// HubSpot contact search endpoint
app.post('/api/search', async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }

  try {
    const url = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
    const query = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "mobilenumber",
              operator: "EQ",
              value: phone
            }
          ]
        }
      ],
      properties: ['firstname', 'lastname','email','mobilenumber', 'customerid', 'accountnumbers','highvalue', 'delinquencystatus','segmentation','outstandingbalance','missedpayment']
    };

    const response = await axios.post(url, query, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    res.json(response.data.results);
  } catch (error) {
    console.error('Error searching contacts:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to search contacts. Please try again later.' });
  }
});

// Handle incoming calls
app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid;
  const caller = req.body.From;
  const startTime = new Date();

  console.log(`Incoming call from ${caller} with CallSid ${callSid}`);

  const response = new twiml.VoiceResponse();
  response.say('Welcome to Truworths.');
  response.say('Press 1 to create an account');
  response.say('Press 2 to log an issue');
  response.say('Press 3 to review account');

  response.gather({
    input: 'speech dtmf',
    action: '/process-speech',
    method: 'POST',
    voice: 'Polly.Ayanda-Neural',
    timeout: 5,
    enhanced: true
  });

  res.type('text/xml');
  res.send(response.toString());

  app.locals.currentCall = {
    caller,
    callSid,
    startTime,
    duration: 0,
    status: 'in-progress',
  };
});

// Process speech using Watson and handle options
app.post('/process-speech', async (req, res) => {
  try {
    const speechResult = req.body.SpeechResult;

    if (!speechResult) {
      return res.status(400).send('No speech input received');
    }

    console.log(`Speech input received: ${speechResult}`);

    let botResponse = '';
    const phone = req.body.From;

    // Helper function to store conversation
    const storeConversation = (userInput, botReply) => {
      const conversationEntry = {
        timestamp: new Date().toISOString(),
        user: userInput,
        bot: botReply,
      };
      app.locals.conversations.push(conversationEntry);
    };

    // Check for Option 3 (review account)
    if (speechResult.toLowerCase().includes('option 3')) {
      botResponse = 'Please wait while I retrieve your account details.';
      if (!phone) {
        botResponse = "I couldn't retrieve your phone number. Please provide it.";
      } else {
        try {
          const url = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
          const query = {
            filterGroups: [
              {
                filters: [
                  {
                    propertyName: 'mobilenumber',
                    operator: 'EQ',
                    value: phone
                  }
                ]
              }
            ],
            properties: ['firstname', 'lastname', 'outstandingbalance']
          };

          const apiResponse = await axios.post(url, query, {
            headers: {
              Authorization: `Bearer ${ACCESS_TOKEN}`,
              'Content-Type': 'application/json'
            }
          });

          const contact = apiResponse.data.results[0];

          if (contact) {
            const { firstname, lastname, outstandingbalance } = contact.properties;
            botResponse = `Based on your account, your name is ${firstname}, your surname is ${lastname}, and your balance is ${outstandingbalance}.`;
          } else {
            botResponse = "I couldn't find your account details.";
          }
        } catch (error) {
          console.error('Error fetching contact details from HubSpot:', error.response?.data || error.message);
          botResponse = "There was an issue retrieving your account details. Please try again later.";
        }
      }
    }
    else if (speechResult.toLowerCase().includes('option 2')) {
  botResponse = 'Please tell us what the issue is.';
  
  const response = new twiml.VoiceResponse();
  response.say(botResponse); // Tell the user what to do next
  response.gather({
    input: 'speech',
    action: '/process-issue',
    method: 'POST',
    voice: 'Polly.Ayanda-Neural',
    timeout: 5,
    enhanced: true,
  });
  
  res.type('text/xml');
  res.send(response.toString());
  // Store conversation entry after the bot response
    storeConversation(speechResult, botResponse);
  return; // Exit this block to avoid unintended execution
}
    // Store conversation entry after the bot response
    storeConversation(speechResult, botResponse);

    // Respond to the user with the final bot response
    const response = new twiml.VoiceResponse();
    response.say(botResponse);
    response.hangup();

    // Update call data
    if (app.locals.currentCall) {
      const currentCall = app.locals.currentCall;
      const callDuration = Math.floor((new Date() - currentCall.startTime) / 1000);
      currentCall.duration = callDuration;
      currentCall.status = 'completed';
      currentCall.conversations = app.locals.conversations;
      app.locals.pastCalls.push(currentCall);
      app.locals.currentCall = null;
      app.locals.conversations = [];
    }

    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    console.error('Error processing speech:', error);

    const response = new twiml.VoiceResponse();
    response.say('I did not catch that. Could you please repeat?');

    response.gather({
      input: 'speech',
      action: '/process-speech',
      method: 'POST',
      voice: 'Polly.Ayanda-Neural',
      timeout: 5,
      enhanced: true,
    });

    res.type('text/xml');
    res.send(response.toString());
  }
});

app.post('/process-issue', async (req, res) => {
  try {
    // Capture the speech input from the user
    const speechResult = req.body.SpeechResult;

    // If no speech result is received, handle it
    if (!speechResult || speechResult.trim() === '') {
      const response = new twiml.VoiceResponse();
      response.say('I didn’t hear anything. Can you please tell me what the issue is?');

      // Gather speech again if no valid input is provided
      response.gather({
        input: 'speech',
        action: '/process-issue',
        method: 'POST',
        voice: 'Polly.Ayanda-Neural',
        timeout: 10,  // Increased timeout to allow more time for user to respond
        enhanced: false
      });

      res.type('text/xml');
      return res.send(response.toString());
    }

    console.log(`Issue input received: ${speechResult}`);

    let botResponse = 'Your issue has been logged successfully. Thank you!';
    const phone = req.body.From;

    // Ensure that phone number is retrieved for further processing
    if (!phone) {
      botResponse = "I couldn't retrieve your phone number. Please provide it.";
    } else {
      try {
        // Query HubSpot for user details using the phone number
        const url = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
        const query = {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: 'mobilenumber',
                  operator: 'EQ',
                  value: phone
                }
              ]
            }
          ],
          properties: ['email']
        };

        const apiResponse = await axios.post(url, query, {
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });

        const contact = apiResponse.data.results[0];

        // If the contact is found, retrieve their email and log the issue
        if (contact) {
          const { email } = contact.properties;
          botResponse = `An issue has been logged for the email ${email}.`;

          // Store the past conversation entry with user phone, email, and conversation
          app.locals.pastConversations.push({
            phone: phone,
            email: email,
            conversation: [...app.locals.conversations],
          });
        } else {
          botResponse = "I couldn't find your account details.";
        }
      } catch (error) {
        console.error('Error fetching contact details from HubSpot:', error.response?.data || error.message);
        botResponse = "There was an issue retrieving your account details. Please try again later.";
      }
    }

    // Store conversation entry after the bot response
    storeConversation(speechResult, botResponse);

    // Respond to the user with the final bot response
    const response = new twiml.VoiceResponse();
    response.say(botResponse);
    response.hangup();

    // Update the call data if it's available
    if (app.locals.currentCall) {
      const currentCall = app.locals.currentCall;
      const callDuration = Math.floor((new Date() - currentCall.startTime) / 1000);
      currentCall.duration = callDuration;
      currentCall.status = 'completed';
      currentCall.conversations = app.locals.conversations;
      app.locals.pastCalls.push(currentCall);
      app.locals.currentCall = null;
      app.locals.conversations = [];
    }

    res.type('text/xml');
    res.send(response.toString());
  } catch (error) {
    console.error('Error processing speech:', error);

    // Handle errors by prompting the user to repeat their input
    const response = new twiml.VoiceResponse();
    response.say('I did not catch that. Could you please repeat?');

    // Gather speech again to try and capture input from the user
    response.gather({
      input: 'speech',
      action: '/process-issue',
      method: 'POST',
      voice: 'Polly.Ayanda-Neural',
      timeout: 10,  // Increased timeout to give more time for user input
      enhanced: true
    });

    res.type('text/xml');
    res.send(response.toString());
  }
});

// Serve call data
app.get('/call-data', (req, res) => {
  if (app.locals.currentCall && app.locals.currentCall.status === 'in-progress') {
    app.locals.currentCall.duration = Math.floor(
      (new Date() - app.locals.currentCall.startTime) / 1000
    );
  }

  res.json({
    currentCall: app.locals.currentCall,
    pastCalls: app.locals.pastCalls,
    conversations: app.locals.conversations,
    pastConversations: app.locals.pastConversations,
  });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
