export interface FaqRecord {
  id: number;
  question: string;
  answer: string;
  keywords: string[];
  is_active: boolean;
  created_at: string;
}
