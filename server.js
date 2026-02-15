import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import pdfParse from "pdf-parse";
import Tesseract from "tesseract.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------------- ENV CONFIG ----------------
dotenv.config();

// ✅ IMPORTANT FIX FOR DEPLOYMENT
const PORT = process.env.PORT || 3000;

// ---------------- OCR FUNCTION ----------------
async function extractTextFromImage(imageBuffer) {
  try {
    console.log("Attempting OCR extraction...");

    const result = await Tesseract.recognize(
      imageBuffer,
      "eng",
      {
        logger: m => console.log(m)
      }
    );

    return result.data.text;
  } catch (error) {
    console.error("OCR Error:", error.message);
    return "";
  }
}

// ---------------- GEMINI SETUP ----------------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function askGeminiForJSON(prompt) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const jsonOnlyPrompt = `
You are an API. Return ONLY valid JSON.
No markdown. No backticks. No extra explanation.

${prompt}
`;

  const result = await model.generateContent(jsonOnlyPrompt);
  const raw = result.response.text();

  try {
    return JSON.parse(raw);
  } catch {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first === -1 || last === -1)
      throw new Error("Gemini did not return JSON.");

    const cleaned = raw.slice(first, last + 1);
    return JSON.parse(cleaned);
  }
}

// ---------------- EXPRESS SETUP ----------------
const server = express();
const upload = multer({ storage: multer.memoryStorage() });

server.use(cors());
server.use(express.static("public"));
server.use(express.json());

// ---------------- ROUTES ----------------

server.get("/", function (req, res) {
  res.json({ message: "this message is from server" });
});

server.post(
  "/resume/upload",
  upload.single("resume"),
  async function (req, res) {

    if (!req.file) {
      return res.status(400).json({ error: "File not uploaded" });
    }

    const targetRole =
      req.body.targetRole || "Software Developer (Fresher)";

    console.log("Extracting text from PDF...");
    let resumeText = "";

    try {
      const pdfData = await pdfParse(req.file.buffer);
      resumeText = (pdfData.text || "").trim();
      console.log(`Extracted ${resumeText.length} characters from PDF`);
    } catch (pdfError) {
      console.error("PDF extraction failed:", pdfError.message);
    }

    // If PDF extraction fails → try OCR
    if (!resumeText) {
      console.log("PDF text empty. Attempting OCR...");

      try {
        resumeText = await extractTextFromImage(req.file.buffer);

        if (!resumeText || resumeText.trim().length === 0) {
          return res.status(400).json({
            error:
              "Could not extract text from PDF. Please upload a proper text-based resume.",
          });
        }

        console.log(`OCR extracted ${resumeText.length} characters`);
      } catch (ocrError) {
        return res.status(400).json({
          error:
            "OCR extraction failed: " + ocrError.message,
        });
      }
    }

    if (!resumeText || resumeText.trim().length < 50) {
      return res.status(400).json({
        error:
          "Extracted text is too short. Please upload a valid resume PDF.",
      });
    }

    console.log("Sending to Gemini for analysis...");

    const prompt = `
Analyze this resume for the target role: "${targetRole}"

Return JSON in EXACT shape:
{
  "atsScore": number (0-100),
  "strengths": ["..."],
  "weakAreas": ["..."],
  "missingSkills": ["..."],
  "projectGaps": ["..."],
  "quickFixes": ["..."],
  "oneLineVerdict": "..."
}

Rules:
- Be beginner-friendly.
- Be realistic.
- Mention projects/deployment/GitHub if missing.

Resume Text:
"""
${resumeText}
"""
`;

    try {
      const analysis = await askGeminiForJSON(prompt);
      console.log("Analysis complete!");

      res.json({
        targetRole,
        fileName: req.file.originalname,
        extractedChars: resumeText.length,
        analysis,
      });

    } catch (err) {
      console.error("Gemini Error:", err.message);
      res.status(500).json({
        error: "AI analysis failed. Please try again.",
      });
    }
  }
);

// ---------------- START SERVER ----------------
server.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
