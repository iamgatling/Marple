export interface TrackEvent {
  event_type: string;
  session_id?: string | null;
  user_id?: string | null;
  url?: string | null;
  referrer?: string | null;
  properties?: Record<string, any>;
  ip?: string | null;
  ua?: string | null;
  country?: string | null;
  timestamp?: string;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_term?: string | null;
  utm_content?: string | null;
  [key: string]: any;
}

export interface OverviewOptions {
  since?: string;
  until?: string;
  goal?: string;
  targetGoal?: string;
}

export interface GoalConversionData {
  goal: string;
  count: number;
  uniqueUsers: number;
  uniqueSessions: number;
  conversionRate: number;
  prevCount: number;
  prevUniqueUsers: number;
  prevUniqueSessions: number;
  prevConversionRate: number;
  change: number;
}

export interface OverviewData {
  totalEvents: number;
  uniqueSessions: number;
  uniqueUsers: number;
  activeNow: number;
  topPages: Array<{ page: string; views: number }>;
  topReferrers: Array<{ referrer: string; count: number }>;
  browsers: Array<{ browser: string; count: number }>;
  devices: Array<{ device_type: string; count: number }>;
  countries: Array<{ country: string; count: number }>;
  dailyViews: Array<{ date: string; views: number }>;
  previousPeriod?: {
    totalEvents: number;
    uniqueSessions: number;
    uniqueUsers: number;
  };
  conversion?: GoalConversionData | null;
  goalConversions?: GoalConversionData[];
  availableGoals?: string[];
}

export interface UsersOptions {
  limit?: number;
  offset?: number;
}

export interface UserRecord {
  id: string;
  first_seen: string;
  last_seen: string;
  country?: string | null;
  browser?: string | null;
  device_type?: string | null;
  event_count?: number;
  properties?: Record<string, any>;
}

export interface UsersData {
  users: UserRecord[];
  total: number;
}

export interface UserProfileData {
  user: UserRecord;
  events: Array<{
    event_type: string;
    url?: string | null;
    properties: Record<string, any>;
    timestamp: string;
  }>;
}

export interface FunnelStep {
  type: string;
  value: string;
  label?: string;
}

export interface FunnelStepResult {
  step: string;
  count: number;
  dropoff: number;
}

export interface RollupConfig {
  keepRawEventsDays?: number;
  keepRollupsDays?: number;
  autoRollup?: boolean;
}

export interface MarpleConfig {
  storage?: string | Driver | { type?: string; [key: string]: any };
  sqlitePath?: string;
  postgresConnectionString?: string;
  connectionString?: string;
  retention?: RollupConfig;
  dev?: boolean;
  dashboardPath?: string;
  [key: string]: any;
}

export interface Driver {
  type?: string;
  writeEvent(ev: TrackEvent): Promise<void>;
  getOverview(options?: OverviewOptions): Promise<OverviewData>;
  getUsers(options?: UsersOptions): Promise<UsersData>;
  getFunnel(steps: FunnelStep[]): Promise<FunnelStepResult[]>;
  getUserProfile?(userId: string): Promise<UserProfileData | null>;
  getCohorts?(): Promise<any[]>;
  getEvents?(options?: OverviewOptions): Promise<any>;
  getConversions?(options?: OverviewOptions): Promise<GoalConversionData[] | GoalConversionData | null>;
  runRollup?(config?: RollupConfig): Promise<void>;
  getPublicConfig?(): MarpleConfig | Promise<MarpleConfig>;
  config?: MarpleConfig;
}
