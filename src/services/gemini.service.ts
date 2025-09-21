import { Injectable, signal } from '@angular/core';
import { GoogleGenAI, Type } from '@google/genai';

export interface OptimizationResult {
  summary: string;
  recommendations: {
    title: string;
    description: string;
  }[];
  optimizedQuery: string;
}

@Injectable({
  providedIn: 'root'
})
export class GeminiService {
  private ai: GoogleGenAI | null = null;
  private readonly model = 'gemini-2.5-flash';

  private _error = signal<string | null>(null);
  private _isInitialized = signal<boolean>(false);

  readonly error = this._error.asReadonly();
  readonly isInitialized = this._isInitialized.asReadonly();

  constructor() {
    try {
      const apiKey = process.env.API_KEY;
      if (!apiKey) {
        throw new Error('API_KEY environment variable not set. Please configure it to use the application.');
      }
      this.ai = new GoogleGenAI({ apiKey });
      this._isInitialized.set(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'An unknown initialization error occurred.';
      this._error.set(message);
      console.error('Gemini Service Initialization Error:', e);
    }
  }

  /**
   * Generates a streaming response for features that produce text or code.
   */
  async *generateStream(feature: string, db: string, input: string, schemaContext: string): AsyncGenerator<string> {
    if (!this.ai) {
      throw new Error('Gemini service is not initialized.');
    }
    const { systemInstruction, userPrompt } = this.getPrompts(feature, db, input, schemaContext);

    try {
      const responseStream = await this.ai.models.generateContentStream({
        model: this.model,
        contents: userPrompt,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.1,
        }
      });

      for await (const chunk of responseStream) {
        yield chunk.text;
      }
    } catch (error) {
      console.error('Error calling Gemini API stream:', error);
      throw new Error('Failed to generate streaming response from AI.');
    }
  }

  /**
   * Generates a structured JSON response for the Optimize Query feature.
   */
  async generateStructured(db: string, input: string, schemaContext: string): Promise<OptimizationResult> {
    if (!this.ai) {
      throw new Error('Gemini service is not initialized.');
    }
    const { systemInstruction, userPrompt, schema } = this.getPrompts('Optimize Query', db, input, schemaContext);

    try {
      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: userPrompt,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: schema,
        }
      });

      const text = response.text;
      if (!text) {
        throw new Error('Received an empty response from the AI.');
      }
      return JSON.parse(text) as OptimizationResult;

    } catch (error) {
      console.error('Error calling Gemini API for structured data:', error);
      throw new Error('Failed to parse structured response from AI.');
    }
  }

  private getPrompts(feature: string, db: string, input: string, schemaContext: string): { systemInstruction: string; userPrompt: string; schema?: any } {
    const contextPreamble = schemaContext.trim() 
      ? `You MUST use the following provided context. Do not invent tables, columns, or data structures that are not in this context.\n\nCONTEXT:\n\`\`\`\n${schemaContext}\n\`\`\`\n\n` 
      : '';

    switch (feature) {
      case 'NL-to-SQL':
        return {
          systemInstruction: `You are a world-class database administrator and SQL expert specializing in ${db}. Your sole purpose is to convert natural language text into a single, syntactically perfect, and highly efficient ${db} SQL query based on the provided context. You ONLY output raw SQL code. You do not provide explanations, comments, or any text other than the SQL query itself. You do not use markdown code blocks.`,
          userPrompt: `${contextPreamble}Convert the following request into a ${db} SQL query: "${input}"`
        };
      case 'Optimize Query':
        return {
          systemInstruction: `You are a world-class database performance tuning specialist for ${db}. Your task is to analyze a SQL query, using the provided schema context if available, and return a JSON object with your findings. You must provide a concise summary, a list of actionable recommendations with titles and descriptions, and the optimized version of the query.`,
          userPrompt: `${contextPreamble}Please analyze and suggest optimizations for this ${db} SQL query, then return the results in the required JSON format:\n\n${input}`,
          schema: {
            type: Type.OBJECT,
            properties: {
              summary: {
                type: Type.STRING,
                description: "A brief summary of the query's performance issues."
              },
              recommendations: {
                type: Type.ARRAY,
                description: "A list of specific optimization recommendations.",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING, description: "A short title for the recommendation (e.g., 'Add Index')." },
                    description: { type: Type.STRING, description: "A detailed explanation of the recommendation and its benefits." }
                  },
                  required: ['title', 'description']
                }
              },
              optimizedQuery: {
                type: Type.STRING,
                description: "The fully optimized SQL query."
              }
            },
            required: ['summary', 'recommendations', 'optimizedQuery']
          }
        };
      case 'Design Schema':
        return {
          systemInstruction: `You are a world-class database architect specializing in ${db}. Your task is to design a well-structured, normalized (3NF) database schema based on a set of requirements. You will provide the complete Data Definition Language (DDL) statements for ${db}, including tables, columns with appropriate data types, primary keys, foreign keys, and necessary indexes. You ONLY output raw SQL DDL code. You do not provide explanations (except as SQL comments) or any text other than the SQL DDL. You do not use markdown code blocks.`,
          userPrompt: `Design a ${db} schema for the following requirements: "${input}"`
        };
      case 'Explain SQL':
        return {
            systemInstruction: `You are a world-class database administrator and SQL expert specializing in ${db}. Your purpose is to explain a given SQL query in a clear, concise, and easy-to-understand manner, using the provided schema for context. Break down the query into its logical parts and explain what each part does and how they work together. Your explanation should be helpful for both beginners and experienced developers.`,
            userPrompt: `${contextPreamble}Please explain this ${db} SQL query step-by-step:\n\n${input}`
        };
      case 'Analyze & Suggest':
        return {
            systemInstruction: `You are a world-class data analyst and database architect for ${db}. Your primary goal is to provide precise, actionable, and highly relevant suggestions. Before you provide a final answer, it is critical that you first evaluate the user's request and the provided context. If the request is vague, ambiguous, or lacks specific details, you MUST ask clarifying questions. Similarly, if the provided context (schema, data, etc.) is insufficient to give a high-quality, accurate answer, you MUST ask for more information. Do not make assumptions. Engage in a dialogue with the user to ensure you have all the necessary details before offering your expert analysis. Format your final response using markdown for readability.`,
            userPrompt: `${contextPreamble}Based on the provided context, please analyze and provide suggestions for the following request: "${input}"`
        };
      default:
         return {
          systemInstruction: 'You are a helpful assistant.',
          userPrompt: input
        };
    }
  }
}