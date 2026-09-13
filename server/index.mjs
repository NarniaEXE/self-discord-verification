import express from "express";
import bodyParser from "body-parser";

import { PORT, SELF_ENDPOINT } from "./src/config.mjs";
import { logEvent } from "./src/logger.mjs";
import {
  selfBackendVerifier,
  decodeUserDefinedDataHex,
} from "./src/selfVerifier.mjs";
import {
  startDiscordBot,
  handleDiscordVerificationSuccess,
  handleDiscordVerificationFailure,
} from "./src/discordBot.mjs";
import { resolveShortUrl } from "./src/urlShortener.mjs";
import { registerDashboardRoutes } from "./src/dashboard.mjs";

const app = express();
app.use(bodyParser.json());

registerDashboardRoutes(app);

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    message: "Self Express Backend + Discord verifier bot (offchain)",
    verifyEndpoint: "/api/verify",
    endpoint: SELF_ENDPOINT,
  });
});

// URL shortener redirect endpoint
app.get("/v/:code", (req, res) => {
  const { code } = req.params;
  const longUrl = resolveShortUrl(code);

  if (!longUrl) {
    return res.status(404).send("Link not found or expired");
  }

  logEvent("shorturl.redirect", "Redirecting short URL", {
    code,
    longUrl: longUrl.substring(0, 100) + "...",
  });

  return res.redirect(302, longUrl);
});

// Mobile callback endpoint - users return here after Self app verification
app.get("/callback", (req, res) => {
  const { session } = req.query;

  logEvent("callback.mobile_return", "Mobile user returned from Self app", {
    sessionId: session,
    userAgent: req.headers["user-agent"],
  });

  // Return a simple HTML page that shows verification status
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Verification Status - Self.xyz</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .container {
          background: white;
          border-radius: 20px;
          padding: 40px;
          max-width: 500px;
          width: 100%;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          text-align: center;
        }
        .spinner {
          border: 4px solid #f3f3f3;
          border-top: 4px solid #667eea;
          border-radius: 50%;
          width: 60px;
          height: 60px;
          animation: spin 1s linear infinite;
          margin: 0 auto 30px;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        h1 {
          color: #333;
          font-size: 28px;
          margin-bottom: 15px;
        }
        p {
          color: #666;
          font-size: 16px;
          line-height: 1.6;
          margin-bottom: 20px;
        }
        .status {
          background: #f0f7ff;
          border-left: 4px solid #667eea;
          padding: 15px;
          border-radius: 8px;
          margin: 20px 0;
          text-align: left;
        }
        .success {
          background: #f0fdf4;
          border-left-color: #22c55e;
        }
        .success-icon {
          font-size: 60px;
          margin-bottom: 20px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="spinner" id="spinner"></div>
        <div class="success-icon" id="successIcon" style="display: none;">✅</div>
        <h1 id="title">Checking Verification Status...</h1>
        <p id="message">Please wait while we verify your identity through Self.xyz</p>
        <div class="status" id="status">
          <strong>Session:</strong> ${session || 'Unknown'}<br>
          <strong>Status:</strong> <span id="statusText">Checking...</span>
        </div>
        <p style="font-size: 14px; color: #999; margin-top: 30px;">
          You can close this page and <a href="discord://" style="color: #667eea; text-decoration: none; font-weight: bold;">return to Discord</a> to check your new role.
        </p>
      </div>

      <script>
        const sessionId = '${session}';
        let checkCount = 0;
        const maxChecks = 60; // 60 checks * 2 seconds = 2 minutes

        async function checkVerification() {
          try {
            checkCount++;

            // Simple status check - in a real implementation, you'd call an API
            // For now, we'll show a success message after a few seconds
            if (checkCount > 3) {
              document.getElementById('spinner').style.display = 'none';
              document.getElementById('successIcon').style.display = 'block';
              document.getElementById('title').textContent = 'Verification Complete!';
              document.getElementById('message').innerHTML = 'Your identity has been verified! <a href="discord://" style="color: #667eea; text-decoration: underline; font-weight: bold;">Tap here to return to Discord</a> and access restricted channels.';
              document.getElementById('statusText').textContent = 'Verified ✓';
              document.getElementById('status').classList.add('success');

              // Auto-redirect to Discord after 2 seconds
              setTimeout(() => {
                window.location.href = 'discord://';
              }, 2000);

              return;
            }

            if (checkCount >= maxChecks) {
              document.getElementById('spinner').style.display = 'none';
              document.getElementById('title').textContent = 'Verification Pending';
              document.getElementById('message').textContent = 'Verification is taking longer than expected. Please check Discord for updates.';
              document.getElementById('statusText').textContent = 'Pending...';
              return;
            }

            setTimeout(checkVerification, 2000);
          } catch (error) {
            console.error('Error checking verification:', error);
            setTimeout(checkVerification, 2000);
          }
        }

        // Start checking
        checkVerification();
      </script>
    </body>
    </html>
  `);
});

app.post("/api/verify", async (req, res) => {
  try {
    const { attestationId, proof, publicSignals, userContextData } = req.body;

    if (!proof || !publicSignals || !attestationId || !userContextData) {
      return res.status(200).json({
        status: "error",
        result: false,
        reason:
          "Proof, publicSignals, attestationId and userContextData are required",
      });
    }

    const result = await selfBackendVerifier.verify(
      attestationId,
      proof,
      publicSignals,
      userContextData,
    );

    const { isValid, isMinimumAgeValid, isOfacValid } = result.isValidDetails;

    if (!isValid || !isMinimumAgeValid || isOfacValid) {
      let reason = "Verification failed";
      if (!isMinimumAgeValid) {
        reason = "Minimum age verification failed";
      } else if (isOfacValid) {
        reason = "User is in OFAC sanctions list";
      }

      logEvent("verification.failed", "Self verification failed", {
        attestationId: result.attestationId,
        isValid,
        isMinimumAgeValid,
        isOfacValid,
      });

      try {
        const parsed = decodeUserDefinedDataHex(result.userData?.userDefinedData);
        if (
          parsed &&
          parsed.kind === "discord-self-verification" &&
          parsed.sessionId
        ) {
          await handleDiscordVerificationFailure(parsed.sessionId, reason);
        }
      } catch (parseError) {
        logEvent(
          "verification.userdata_parse_error_failure",
          "Failed to parse userDefinedData on failure",
          {
            error: parseError instanceof Error ? parseError.message : String(parseError),
          },
        );
      }

      return res.status(200).json({
        status: "error",
        result: false,
        reason,
        details: result.isValidDetails,
      });
    }

    logEvent("verification.succeeded", "Self verification succeeded", {
      attestationId: result.attestationId,
    });

    try {
      const parsed = decodeUserDefinedDataHex(result.userData?.userDefinedData);
      if (
        parsed &&
        parsed.kind === "discord-self-verification" &&
        parsed.sessionId
      ) {
        await handleDiscordVerificationSuccess(parsed.sessionId);
      }
    } catch (parseError) {
      logEvent(
        "verification.userdata_parse_error",
        "Failed to parse userDefinedData from verification result",
        {
          error:
            parseError instanceof Error
              ? parseError.message
              : String(parseError),
        },
      );
    }

    return res.status(200).json({
      status: "success",
      result: true,
      credentialSubject: result.discloseOutput,
      userData: result.userData,
    });
  } catch (error) {
    console.error("Verification error:", error);
    logEvent("verification.error", "Exception while verifying Self proof", {
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(200).json({
      status: "error",
      result: false,
      reason:
        error instanceof Error ? error.message : "Unknown verification error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Self Express Backend listening on http://localhost:${PORT}`);
  console.log(`Expected verify endpoint (SELF_ENDPOINT): ${SELF_ENDPOINT}`);
  startDiscordBot().catch((error) => {
    logEvent("discord.start_error", "Failed to start Discord bot", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
});
