import { Component, ChangeDetectionStrategy, signal, computed, inject, effect, viewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GeminiService, OptimizationResult } from './services/gemini.service';

type Feature = 'NL-to-SQL' | 'Optimize Query' | 'Design Schema' | 'Explain SQL' | 'Analyze & Suggest';

interface HistoryItem {
  id: number;
  feature: Feature;
  db: string;
  userInput: string;
  schemaContext: string;
  uploadedFileName: string;
  output: string;
  optimizationResult: OptimizationResult | null;
}

// Make highlight.js available
declare var hljs: any;

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule]
})
export class AppComponent {
  private geminiService = inject(GeminiService);
  private readonly storageKey = 'db_guru_history';

  readonly features: Feature[] = ['NL-to-SQL', 'Optimize Query', 'Design Schema', 'Explain SQL', 'Analyze & Suggest'];
  readonly databases = ['PostgreSQL', 'MySQL', 'SQL Server', 'Oracle', 'SQLite'];

  // State Signals
  selectedFeature = signal<Feature>(this.features[0]);
  selectedDb = signal<string>(this.databases[0]);
  schemaContext = signal<string>('');
  uploadedFileName = signal<string>('');
  userInput = signal<string>('');
  output = signal<string>('');
  optimizationResult = signal<OptimizationResult | null>(null);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);
  copied = signal<boolean>(false);
  history = signal<HistoryItem[]>([]);
  isContextVisible = signal<boolean>(true);

  // ElementRef for the output container to apply syntax highlighting
  outputContainer = viewChild<ElementRef>('outputContainer');
  fileInput = viewChild<ElementRef>('fileInput');

  constructor() {
    this.loadHistoryFromStorage();
    // Effect to apply syntax highlighting whenever the output changes
    effect(() => {
        if (this.outputContainer() && (this.output() || this.optimizationResult())) {
            setTimeout(() => {
                const codeBlocks = this.outputContainer()!.nativeElement.querySelectorAll('pre code');
                codeBlocks.forEach((block: HTMLElement) => {
                    hljs.highlightElement(block);
                });
            }, 0);
        }
    });
  }

  // Computed Signal for placeholder text
  placeholder = computed(() => {
    switch (this.selectedFeature()) {
      case 'NL-to-SQL':
        return 'e.g., Show me all users from Canada who signed up in the last month';
      case 'Optimize Query':
        return 'e.g., SELECT * FROM users u JOIN orders o ON u.id = o.user_id WHERE u.country = \'Canada\'';
      case 'Design Schema':
        return 'e.g., Design a schema for a simple blog with users, posts, and comments';
      case 'Explain SQL':
        return 'e.g., SELECT u.name, COUNT(p.id) FROM users u LEFT JOIN posts p ON u.id = p.user_id GROUP BY u.name HAVING COUNT(p.id) > 5;';
      case 'Analyze & Suggest':
        return 'e.g., Analyze this schema and suggest three improvements for performance.';
      default:
        return '';
    }
  });

  selectFeature(feature: Feature): void {
    this.selectedFeature.set(feature);
    this.userInput.set('');
    this.output.set('');
    this.optimizationResult.set(null);
    this.error.set(null);
    this.clearSchemaContext();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) {
      return;
    }
    
    const file = input.files[0];
    const reader = new FileReader();

    reader.onload = (e) => {
      const text = e.target?.result;
      this.schemaContext.set(text as string);
      this.uploadedFileName.set(file.name);
      this.isContextVisible.set(true); // Ensure context is visible on file upload
    };

    reader.onerror = (e) => {
        this.error.set(`Error reading file: ${e.target?.error?.message}`);
        console.error('File reading error:', e.target?.error);
    };

    reader.readAsText(file);
  }

  clearSchemaContext(): void {
    this.schemaContext.set('');
    this.uploadedFileName.set('');
    if (this.fileInput()) {
      this.fileInput()!.nativeElement.value = '';
    }
  }

  toggleContextVisibility(): void {
    this.isContextVisible.update(v => !v);
  }

  async generate(): Promise<void> {
    if (!this.userInput().trim() || this.loading()) {
      return;
    }

    this.loading.set(true);
    this.output.set('');
    this.optimizationResult.set(null);
    this.error.set(null);

    let finalOutput = '';
    let finalOptimizationResult: OptimizationResult | null = null;

    try {
      const feature = this.selectedFeature();
      const db = this.selectedDb();
      const input = this.userInput();
      const schema = this.schemaContext();

      if (feature === 'Optimize Query') {
        const result = await this.geminiService.generateStructured(db, input, schema);
        this.optimizationResult.set(result);
        finalOptimizationResult = result;
      } else {
        const stream = this.geminiService.generateStream(feature, db, input, schema);
        for await (const chunk of stream) {
          this.output.update(current => current + chunk);
        }
        finalOutput = this.output();
      }
      
      // Save to history on success
      this.addToHistory({
        feature: feature,
        db: db,
        userInput: input,
        schemaContext: schema,
        uploadedFileName: this.uploadedFileName(),
        output: finalOutput,
        optimizationResult: finalOptimizationResult
      });

    } catch (e) {
      const rawMessage = e instanceof Error ? e.message : 'An unknown error occurred.';
      let displayMessage = `An error occurred while communicating with the AI: ${rawMessage}`;
      
      if (rawMessage.includes('token count exceeds') || rawMessage.includes('400')) {
        displayMessage = 'Error: The provided context is too large. Please use a smaller file or reduce the amount of text in the context field.';
      }

      this.error.set(displayMessage);
      console.error(e);
    } finally {
      this.loading.set(false);
    }
  }

  copyToClipboard(textToCopy: string): void {
    if (!textToCopy) return;
    navigator.clipboard.writeText(textToCopy).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    });
  }
  
  // History Management
  private addToHistory(item: Omit<HistoryItem, 'id'>): void {
    const newItem: HistoryItem = { ...item, id: Date.now() };
    this.history.update(currentHistory => [newItem, ...currentHistory]);
    this.saveHistoryToStorage();
  }

  loadHistoryItem(item: HistoryItem): void {
    this.selectedFeature.set(item.feature);
    this.selectedDb.set(item.db);
    this.userInput.set(item.userInput);
    this.schemaContext.set(item.schemaContext);
    this.uploadedFileName.set(item.uploadedFileName);
    this.output.set(item.output);
    this.optimizationResult.set(item.optimizationResult);
    this.error.set(null);
  }

  clearHistory(): void {
    if (confirm('Are you sure you want to clear the entire history? This cannot be undone.')) {
        this.history.set([]);
        localStorage.removeItem(this.storageKey);
    }
  }

  private saveHistoryToStorage(): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.history()));
    } catch (e) {
      console.error('Failed to save history to localStorage:', e);
    }
  }

  private loadHistoryFromStorage(): void {
    try {
      const storedHistory = localStorage.getItem(this.storageKey);
      if (storedHistory) {
        this.history.set(JSON.parse(storedHistory));
      }
    } catch (e) {
      console.error('Failed to load history from localStorage:', e);
      this.history.set([]);
    }
  }
}