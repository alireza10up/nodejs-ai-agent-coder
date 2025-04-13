const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const readline = require('readline');

class DevAgentSystem {
    constructor(apiKey, baseURL = "https://api.openai.com/v1") {
        this.openai = new OpenAI({
            apiKey: apiKey,
            baseURL: baseURL
        });

        this.projectPath = '';
        this.currentContext = [];
        this.fileStructure = {};

        // Rate limiting parameters
        this.requestQueue = [];
        this.isProcessing = false;
        this.requestsPerMinute = 3; // Based on your limit
        this.requestTimestamps = [];
    }

    createReadlineInterface() {
        return readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }

    async askQuestion(question) {
        const rl = this.createReadlineInterface();

        return new Promise(resolve => {
            rl.question(question, (answer) => {
                rl.close();
                resolve(answer);
            });
        });
    }

    async initialize() {
        const projectName = await this.askQuestion("What should we name your project? ");
        const projectDescription = await this.askQuestion("Describe what your project should do: ");
        const projectPath = await this.askQuestion("Where should we create this project? (default: ./): ");

        this.projectPath = path.join(projectPath || './', projectName);

        // Create project directory if it doesn't exist
        if (!fs.existsSync(this.projectPath)) {
            fs.mkdirSync(this.projectPath, { recursive: true });
            console.log(`Created project directory: ${this.projectPath}`);
        }

        return {
            projectName,
            projectDescription,
            projectPath: this.projectPath
        };
    }

    // Rate limit aware API call
    async makeApiCall(params) {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({
                params,
                resolve,
                reject
            });

            if (!this.isProcessing) {
                this.processQueue();
            }
        });
    }

    async processQueue() {
        if (this.requestQueue.length === 0) {
            this.isProcessing = false;
            return;
        }

        this.isProcessing = true;

        // Check if we need to wait due to rate limiting
        const now = Date.now();
        this.requestTimestamps = this.requestTimestamps.filter(
            time => now - time < 60000
        );

        if (this.requestTimestamps.length >= this.requestsPerMinute) {
            const oldestRequest = this.requestTimestamps[0];
            const waitTime = 60000 - (now - oldestRequest) + 100; // Add 100ms buffer

            console.log(`Rate limit reached. Waiting ${Math.ceil(waitTime / 1000)} seconds before next request...`);

            setTimeout(() => {
                this.processQueue();
            }, waitTime);

            return;
        }

        // Process the next request
        const request = this.requestQueue.shift();
        this.requestTimestamps.push(Date.now());

        try {
            const response = await this.openai.chat.completions.create(request.params);
            request.resolve(response);
        } catch (error) {
            if (error.status === 429) {
                console.log("Rate limit hit. Requeueing request with backoff...");

                // Wait longer and try again
                setTimeout(() => {
                    this.requestQueue.unshift(request);
                    this.processQueue();
                }, 15000);
            } else {
                request.reject(error);
            }
        }

        // Continue processing queue
        setTimeout(() => {
            this.processQueue();
        }, 500); // Small delay between requests
    }

    async processUserRequest(request) {
        // Add user request to context
        this.currentContext.push({
            role: "user",
            content: request
        });

        console.log("Planning your project structure...");

        // First, get the AI to analyze and plan the project
        const planningResponse = await this.makeApiCall({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `You are a developer agent. A user has requested to build: "${request}".
          Provide a JSON response with the following structure:
          {
            "projectDescription": "Brief description of the project",
            "fileStructure": {
              "filename1.ext": "description of the file purpose",
              "filename2.ext": "description of the file purpose",
              ...
            },
            "implementationPlan": ["Step 1", "Step 2", ...]
          }`
                }
            ]
        });

        const planText = planningResponse.choices[0].message.content;
        let plan;

        try {
            plan = JSON.parse(planText);
        } catch (e) {
            // If JSON parsing fails, extract JSON using regex
            const jsonMatch = planText.match(/```json([\s\S]*?)```/) ||
                planText.match(/{[\s\S]*}/);

            if (jsonMatch) {
                try {
                    plan = JSON.parse(jsonMatch[0].replace(/```json|```/g, '').trim());
                } catch (e2) {
                    throw new Error("Could not parse project plan");
                }
            } else {
                throw new Error("Could not extract project plan");
            }
        }

        // Store the plan
        this.fileStructure = plan.fileStructure;

        // Display the plan to the user
        console.log("\n📋 Project Plan:");
        console.log(`📝 Description: ${plan.projectDescription}`);
        console.log("\n📁 Files to be created:");
        for (const [filename, description] of Object.entries(plan.fileStructure)) {
            console.log(`   - ${filename}: ${description}`);
        }

        // Ask user for confirmation
        const confirmation = await this.askQuestion("\nDo you want to proceed with this plan? (yes/no): ");
        if (confirmation.toLowerCase() !== 'yes' && confirmation.toLowerCase() !== 'y') {
            console.log("Project creation cancelled.");
            return null;
        }

        // Now create each file with content
        console.log("\nCreating project files...");
        for (const [filename, description] of Object.entries(plan.fileStructure)) {
            try {
                await this.createFile(filename, description);
                console.log(`✅ Created: ${filename}`);
            } catch (error) {
                console.error(`❌ Error creating ${filename}: ${error.message}`);
            }
        }

        // Generate instructions
        console.log("\nGenerating run instructions...");
        const instructions = await this.generateRunInstructions();

        return {
            projectDescription: plan.projectDescription,
            fileStructure: plan.fileStructure,
            implementationPlan: plan.implementationPlan,
            runInstructions: instructions
        };
    }

    async createFile(filename, description) {
        const filePath = path.join(this.projectPath, filename);

        // Ensure directory exists
        const dirPath = path.dirname(filePath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        // Generate content for the file
        const contentResponse = await this.makeApiCall({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `You are a developer agent. Generate code for a file with the following description: "${description}". 
          The file is part of the project structure. Provide only the code, no explanations or markdown formatting.`
                }
            ]
        });

        let content = contentResponse.choices[0].message.content;

        // Clean up markdown code blocks if present
        content = content.replace(/```[\w]*\n|```$/g, '');

        // Write the file
        fs.writeFileSync(filePath, content);

        return filePath;
    }

    async generateRunInstructions() {
        const instructionsResponse = await this.makeApiCall({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `You are a developer agent. Generate clear instructions on how to run and use the project with the following file structure:
          ${JSON.stringify(this.fileStructure, null, 2)}
          
          Include any necessary setup steps, dependencies to install, and commands to run the project.`
                }
            ]
        });

        return instructionsResponse.choices[0].message.content;
    }
}

// Example usage
async function main() {
    console.log("🤖 Welcome to the AI Developer Agent!");
    console.log("------------------------------------");

    // Initialize with API key - in production, use environment variables
    const apiKey = process.env.OPENAI_API_KEY || await askForApiKey();
    const baseURL = process.env.OPENAI_BASE_URL || "https://api.avalai.ir/v1";

    const devAgent = new DevAgentSystem(apiKey, baseURL);

    // Initialize project with interactive prompts
    const projectDetails = await devAgent.initialize();

    console.log(`\n🚀 Starting to build: ${projectDetails.projectName}`);

    // Process the user's project request
    const result = await devAgent.processUserRequest(projectDetails.projectDescription);

    if (result) {
        console.log("\n✨ Project created successfully! ✨");
        console.log("\n📝 Project Description:");
        console.log(result.projectDescription);

        console.log("\n🚀 How to Run Your Project:");
        console.log(result.runInstructions);
    }
}

async function askForApiKey() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise(resolve => {
        rl.question("Please enter your OpenAI API key: ", (apiKey) => {
            rl.close();
            resolve(apiKey);
        });
    });
}

main().catch(console.error);
