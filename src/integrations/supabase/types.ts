export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      password_reset_tokens: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          token_hash: string
          used: boolean
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: string
          token_hash: string
          used?: boolean
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          token_hash?: string
          used?: boolean
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          id: string
          updated_at: string | null
          username: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          id: string
          updated_at?: string | null
          username: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          id?: string
          updated_at?: string | null
          username?: string
        }
        Relationships: []
      }
      race_polling: {
        Row: {
          as_of: string | null
          candidate_a_name: string | null
          candidate_a_party: string | null
          candidate_a_pct: number | null
          candidate_b_name: string | null
          candidate_b_party: string | null
          candidate_b_pct: number | null
          created_at: string
          id: string
          last_updated: string
          poll_count: number | null
          race_id: string
          raw_data: Json | null
          rcp_url: string | null
          source: string
          source_url: string | null
          spread: string | null
        }
        Insert: {
          as_of?: string | null
          candidate_a_name?: string | null
          candidate_a_party?: string | null
          candidate_a_pct?: number | null
          candidate_b_name?: string | null
          candidate_b_party?: string | null
          candidate_b_pct?: number | null
          created_at?: string
          id?: string
          last_updated?: string
          poll_count?: number | null
          race_id: string
          raw_data?: Json | null
          rcp_url?: string | null
          source?: string
          source_url?: string | null
          spread?: string | null
        }
        Update: {
          as_of?: string | null
          candidate_a_name?: string | null
          candidate_a_party?: string | null
          candidate_a_pct?: number | null
          candidate_b_name?: string | null
          candidate_b_party?: string | null
          candidate_b_pct?: number | null
          created_at?: string
          id?: string
          last_updated?: string
          poll_count?: number | null
          race_id?: string
          raw_data?: Json | null
          rcp_url?: string | null
          source?: string
          source_url?: string | null
          spread?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "race_polling_race_id_fkey"
            columns: ["race_id"]
            isOneToOne: false
            referencedRelation: "races"
            referencedColumns: ["race_id"]
          },
        ]
      }
      race_polls: {
        Row: {
          candidate_name: string
          candidate_party: string | null
          created_at: string
          field_end: string
          field_start: string | null
          id: string
          matchup: string | null
          pct: number
          pollster: string
          race_id: string
          sample_kind: string | null
          sample_size: number | null
          source: string
          source_url: string | null
        }
        Insert: {
          candidate_name: string
          candidate_party?: string | null
          created_at?: string
          field_end: string
          field_start?: string | null
          id?: string
          matchup?: string | null
          pct: number
          pollster: string
          race_id: string
          sample_kind?: string | null
          sample_size?: number | null
          source?: string
          source_url?: string | null
        }
        Update: {
          candidate_name?: string
          candidate_party?: string | null
          created_at?: string
          field_end?: string
          field_start?: string | null
          id?: string
          matchup?: string | null
          pct?: number
          pollster?: string
          race_id?: string
          sample_kind?: string | null
          sample_size?: number | null
          source?: string
          source_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "race_polls_race_id_fkey"
            columns: ["race_id"]
            isOneToOne: false
            referencedRelation: "races"
            referencedColumns: ["race_id"]
          },
        ]
      }
      races: {
        Row: {
          created_at: string
          district: string | null
          featured: boolean | null
          race_id: string
          rcp_url: string | null
          slug: string | null
          state: string | null
          year: number | null
        }
        Insert: {
          created_at?: string
          district?: string | null
          featured?: boolean | null
          race_id?: string
          rcp_url?: string | null
          slug?: string | null
          state?: string | null
          year?: number | null
        }
        Update: {
          created_at?: string
          district?: string | null
          featured?: boolean | null
          race_id?: string
          rcp_url?: string | null
          slug?: string | null
          state?: string | null
          year?: number | null
        }
        Relationships: []
      }
      tx_candidates: {
        Row: {
          bio: string | null
          committee_filer_ident: string | null
          committee_name: string | null
          created_at: string
          election_year: number
          facebook_user: string | null
          featured: boolean
          filer_ident: string
          id: string
          instagram_user: string | null
          name: string
          office: string
          party: string | null
          photo_url: string | null
          photo_url_large: string | null
          photo_url_medium: string | null
          photo_url_thumb: string | null
          slug: string
          status: string | null
          title: string | null
          twitter_user: string | null
          updated_at: string
          website: string | null
          youtube_user: string | null
        }
        Insert: {
          bio?: string | null
          committee_filer_ident?: string | null
          committee_name?: string | null
          created_at?: string
          election_year?: number
          facebook_user?: string | null
          featured?: boolean
          filer_ident: string
          id?: string
          instagram_user?: string | null
          name: string
          office?: string
          party?: string | null
          photo_url?: string | null
          photo_url_large?: string | null
          photo_url_medium?: string | null
          photo_url_thumb?: string | null
          slug: string
          status?: string | null
          title?: string | null
          twitter_user?: string | null
          updated_at?: string
          website?: string | null
          youtube_user?: string | null
        }
        Update: {
          bio?: string | null
          committee_filer_ident?: string | null
          committee_name?: string | null
          created_at?: string
          election_year?: number
          facebook_user?: string | null
          featured?: boolean
          filer_ident?: string
          id?: string
          instagram_user?: string | null
          name?: string
          office?: string
          party?: string | null
          photo_url?: string | null
          photo_url_large?: string | null
          photo_url_medium?: string | null
          photo_url_thumb?: string | null
          slug?: string
          status?: string | null
          title?: string | null
          twitter_user?: string | null
          updated_at?: string
          website?: string | null
          youtube_user?: string | null
        }
        Relationships: []
      }
      tx_contributions: {
        Row: {
          amount: number
          candidate_id: string | null
          city: string | null
          contribution_date: string | null
          contribution_info_id: number
          contributor_first_name: string | null
          contributor_last_name: string | null
          contributor_type: string | null
          created_at: string
          cycle: string | null
          employer: string | null
          filer_ident: string
          id: string
          occupation: string | null
          out_of_state_pac: boolean
          report_info_ident: number
          source_form_type: string | null
          state: string | null
          updated_at: string
          zip: string | null
        }
        Insert: {
          amount: number
          candidate_id?: string | null
          city?: string | null
          contribution_date?: string | null
          contribution_info_id: number
          contributor_first_name?: string | null
          contributor_last_name?: string | null
          contributor_type?: string | null
          created_at?: string
          cycle?: string | null
          employer?: string | null
          filer_ident: string
          id?: string
          occupation?: string | null
          out_of_state_pac?: boolean
          report_info_ident: number
          source_form_type?: string | null
          state?: string | null
          updated_at?: string
          zip?: string | null
        }
        Update: {
          amount?: number
          candidate_id?: string | null
          city?: string | null
          contribution_date?: string | null
          contribution_info_id?: number
          contributor_first_name?: string | null
          contributor_last_name?: string | null
          contributor_type?: string | null
          created_at?: string
          cycle?: string | null
          employer?: string | null
          filer_ident?: string
          id?: string
          occupation?: string | null
          out_of_state_pac?: boolean
          report_info_ident?: number
          source_form_type?: string | null
          state?: string | null
          updated_at?: string
          zip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tx_contributions_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tx_contributions_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_contributions_summary"
            referencedColumns: ["candidate_id"]
          },
          {
            foreignKeyName: "tx_contributions_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_ie_by_candidate"
            referencedColumns: ["candidate_id"]
          },
        ]
      }
      tx_expenditures: {
        Row: {
          amount: number
          candidate_id: string | null
          category_code: string | null
          created_at: string
          cycle: string | null
          description: string | null
          expend_info_id: number
          expenditure_date: string | null
          filer_ident: string
          id: string
          payee_city: string | null
          payee_first_name: string | null
          payee_last_name: string | null
          payee_state: string | null
          payee_type: string | null
          payee_zip: string | null
          report_info_ident: number
          source_form_type: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          candidate_id?: string | null
          category_code?: string | null
          created_at?: string
          cycle?: string | null
          description?: string | null
          expend_info_id: number
          expenditure_date?: string | null
          filer_ident: string
          id?: string
          payee_city?: string | null
          payee_first_name?: string | null
          payee_last_name?: string | null
          payee_state?: string | null
          payee_type?: string | null
          payee_zip?: string | null
          report_info_ident: number
          source_form_type?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          candidate_id?: string | null
          category_code?: string | null
          created_at?: string
          cycle?: string | null
          description?: string | null
          expend_info_id?: number
          expenditure_date?: string | null
          filer_ident?: string
          id?: string
          payee_city?: string | null
          payee_first_name?: string | null
          payee_last_name?: string | null
          payee_state?: string | null
          payee_type?: string | null
          payee_zip?: string | null
          report_info_ident?: number
          source_form_type?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tx_expenditures_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tx_expenditures_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_contributions_summary"
            referencedColumns: ["candidate_id"]
          },
          {
            foreignKeyName: "tx_expenditures_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_ie_by_candidate"
            referencedColumns: ["candidate_id"]
          },
        ]
      }
      tx_filings: {
        Row: {
          cash_on_hand: number | null
          created_at: string
          election_dt: string | null
          election_type: string | null
          filed_dt: string | null
          filer_ident: string
          filer_name: string | null
          form_type: string | null
          loan_balance: number | null
          period_end: string | null
          period_start: string | null
          received_dt: string | null
          report_info_ident: number
          report_types: string | null
          superseded: boolean
          total_contribs: number | null
          total_expend: number | null
          unitemized_contribs: number | null
          unitemized_expend: number | null
          updated_at: string
        }
        Insert: {
          cash_on_hand?: number | null
          created_at?: string
          election_dt?: string | null
          election_type?: string | null
          filed_dt?: string | null
          filer_ident: string
          filer_name?: string | null
          form_type?: string | null
          loan_balance?: number | null
          period_end?: string | null
          period_start?: string | null
          received_dt?: string | null
          report_info_ident: number
          report_types?: string | null
          superseded?: boolean
          total_contribs?: number | null
          total_expend?: number | null
          unitemized_contribs?: number | null
          unitemized_expend?: number | null
          updated_at?: string
        }
        Update: {
          cash_on_hand?: number | null
          created_at?: string
          election_dt?: string | null
          election_type?: string | null
          filed_dt?: string | null
          filer_ident?: string
          filer_name?: string | null
          form_type?: string | null
          loan_balance?: number | null
          period_end?: string | null
          period_start?: string | null
          received_dt?: string | null
          report_info_ident?: number
          report_types?: string | null
          superseded?: boolean
          total_contribs?: number | null
          total_expend?: number | null
          unitemized_contribs?: number | null
          unitemized_expend?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      tx_ie_committee_targets: {
        Row: {
          ie_filer_ident: string
          note: string | null
          support_oppose: string
          target_candidate_id: string
        }
        Insert: {
          ie_filer_ident: string
          note?: string | null
          support_oppose?: string
          target_candidate_id: string
        }
        Update: {
          ie_filer_ident?: string
          note?: string | null
          support_oppose?: string
          target_candidate_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tx_ie_committee_targets_target_candidate_id_fkey"
            columns: ["target_candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tx_ie_committee_targets_target_candidate_id_fkey"
            columns: ["target_candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_contributions_summary"
            referencedColumns: ["candidate_id"]
          },
          {
            foreignKeyName: "tx_ie_committee_targets_target_candidate_id_fkey"
            columns: ["target_candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_ie_by_candidate"
            referencedColumns: ["candidate_id"]
          },
        ]
      }
      tx_ie_committees: {
        Row: {
          created_at: string
          filer_ident: string
          name: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          filer_ident: string
          name?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          filer_ident?: string
          name?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      tx_ie_contributions: {
        Row: {
          amount: number
          city: string | null
          contribution_date: string | null
          contribution_info_id: number
          contributor_first_name: string | null
          contributor_last_name: string | null
          contributor_type: string | null
          created_at: string
          cycle: string | null
          employer: string | null
          id: string
          ie_filer_ident: string
          occupation: string | null
          out_of_state_pac: boolean
          report_info_ident: number
          source_form_type: string | null
          state: string | null
          updated_at: string
          zip: string | null
        }
        Insert: {
          amount: number
          city?: string | null
          contribution_date?: string | null
          contribution_info_id: number
          contributor_first_name?: string | null
          contributor_last_name?: string | null
          contributor_type?: string | null
          created_at?: string
          cycle?: string | null
          employer?: string | null
          id?: string
          ie_filer_ident: string
          occupation?: string | null
          out_of_state_pac?: boolean
          report_info_ident: number
          source_form_type?: string | null
          state?: string | null
          updated_at?: string
          zip?: string | null
        }
        Update: {
          amount?: number
          city?: string | null
          contribution_date?: string | null
          contribution_info_id?: number
          contributor_first_name?: string | null
          contributor_last_name?: string | null
          contributor_type?: string | null
          created_at?: string
          cycle?: string | null
          employer?: string | null
          id?: string
          ie_filer_ident?: string
          occupation?: string | null
          out_of_state_pac?: boolean
          report_info_ident?: number
          source_form_type?: string | null
          state?: string | null
          updated_at?: string
          zip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tx_ie_contributions_ie_filer_ident_fkey"
            columns: ["ie_filer_ident"]
            isOneToOne: false
            referencedRelation: "tx_ie_committees"
            referencedColumns: ["filer_ident"]
          },
        ]
      }
      tx_independent_expenditures: {
        Row: {
          amount: number
          category_code: string | null
          created_at: string
          cycle: string | null
          description: string | null
          expend_info_id: number
          expend_persent_id: number
          expenditure_date: string | null
          id: string
          ie_filer_ident: string
          report_info_ident: number
          support_oppose: string
          target_candidate_id: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          category_code?: string | null
          created_at?: string
          cycle?: string | null
          description?: string | null
          expend_info_id: number
          expend_persent_id: number
          expenditure_date?: string | null
          id?: string
          ie_filer_ident: string
          report_info_ident: number
          support_oppose?: string
          target_candidate_id?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          category_code?: string | null
          created_at?: string
          cycle?: string | null
          description?: string | null
          expend_info_id?: number
          expend_persent_id?: number
          expenditure_date?: string | null
          id?: string
          ie_filer_ident?: string
          report_info_ident?: number
          support_oppose?: string
          target_candidate_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tx_independent_expenditures_ie_filer_ident_fkey"
            columns: ["ie_filer_ident"]
            isOneToOne: false
            referencedRelation: "tx_ie_committees"
            referencedColumns: ["filer_ident"]
          },
          {
            foreignKeyName: "tx_independent_expenditures_target_candidate_id_fkey"
            columns: ["target_candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tx_independent_expenditures_target_candidate_id_fkey"
            columns: ["target_candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_contributions_summary"
            referencedColumns: ["candidate_id"]
          },
          {
            foreignKeyName: "tx_independent_expenditures_target_candidate_id_fkey"
            columns: ["target_candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_ie_by_candidate"
            referencedColumns: ["candidate_id"]
          },
        ]
      }
      tx_loans: {
        Row: {
          amount: number
          candidate_id: string | null
          created_at: string
          cycle: string | null
          filer_ident: string
          id: string
          is_guarantor: boolean
          lender_first_name: string | null
          lender_last_name: string | null
          lender_type: string | null
          loan_date: string | null
          loan_info_id: number
          report_info_ident: number
          updated_at: string
        }
        Insert: {
          amount: number
          candidate_id?: string | null
          created_at?: string
          cycle?: string | null
          filer_ident: string
          id?: string
          is_guarantor?: boolean
          lender_first_name?: string | null
          lender_last_name?: string | null
          lender_type?: string | null
          loan_date?: string | null
          loan_info_id: number
          report_info_ident: number
          updated_at?: string
        }
        Update: {
          amount?: number
          candidate_id?: string | null
          created_at?: string
          cycle?: string | null
          filer_ident?: string
          id?: string
          is_guarantor?: boolean
          lender_first_name?: string | null
          lender_last_name?: string | null
          lender_type?: string | null
          loan_date?: string | null
          loan_info_id?: number
          report_info_ident?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tx_loans_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tx_loans_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_contributions_summary"
            referencedColumns: ["candidate_id"]
          },
          {
            foreignKeyName: "tx_loans_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "tx_ie_by_candidate"
            referencedColumns: ["candidate_id"]
          },
        ]
      }
    }
    Views: {
      tx_contributions_deduped: {
        Row: {
          amount: number | null
          candidate_id: string | null
          city: string | null
          contribution_date: string | null
          contributor_first_name: string | null
          contributor_last_name: string | null
          contributor_type: string | null
          cycle: string | null
          employer: string | null
          filer_ident: string | null
          id: string | null
          occupation: string | null
          source_form_type: string | null
          state: string | null
          zip: string | null
        }
        Relationships: []
      }
      tx_contributions_summary: {
        Row: {
          as_of: string | null
          candidate_id: string | null
          cycle: string | null
          entity_contributions: number | null
          filer_ident: string | null
          individual_contributions: number | null
          individual_donor_count: number | null
          name: string | null
          slug: string | null
          small_dollar_contributions: number | null
          small_dollar_count: number | null
          total_raised: number | null
        }
        Relationships: []
      }
      tx_ie_by_candidate: {
        Row: {
          as_of: string | null
          candidate_id: string | null
          committee_count: number | null
          cycle: string | null
          name: string | null
          opposing_count: number | null
          slug: string | null
          supporting_count: number | null
          total_opposing: number | null
          total_supporting: number | null
        }
        Relationships: []
      }
      tx_top_donors: {
        Row: {
          candidate_id: string | null
          city: string | null
          contribution_count: number | null
          contributor_first_name: string | null
          contributor_last_name: string | null
          contributor_type: string | null
          employer: string | null
          last_contribution_date: string | null
          occupation: string | null
          state: string | null
          total_amount: number | null
        }
        Relationships: []
      }
      tx_top_ie_donors: {
        Row: {
          city: string | null
          contribution_count: number | null
          contributor_first_name: string | null
          contributor_last_name: string | null
          contributor_type: string | null
          employer: string | null
          ie_filer_ident: string | null
          last_contribution_date: string | null
          norm_first_key: string | null
          norm_last_key: string | null
          occupation: string | null
          state: string | null
          total_amount: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tx_ie_contributions_ie_filer_ident_fkey"
            columns: ["ie_filer_ident"]
            isOneToOne: false
            referencedRelation: "tx_ie_committees"
            referencedColumns: ["filer_ident"]
          },
        ]
      }
    }
    Functions: {
      get_user_id_by_email: { Args: { lookup_email: string }; Returns: string }
      refresh_tx_finance_views: { Args: never; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
