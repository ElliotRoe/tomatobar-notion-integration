import * as dotenv from 'dotenv';
import { Client } from '@notionhq/client';
import { promises as fs } from 'fs';

dotenv.config();

// Initializing a client
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

type WorkNotionDatabasePropertySchema = {
  Name: {
    title: {
      text: {
        content: string;
      };
    };
  };
  'Working Time': {
    date: {
      start: string;
      end: string;
    };
    type: 'date';
  };
};

const createWorkProperty = async (
  start: Date,
  end: Date,
): Promise<WorkNotionDatabasePropertySchema> => {
  const startISO = start.toISOString();
  const endISO = end.toISOString();
  const minuteDuration = (end.getTime() - start.getTime()) / 1000 / 60;

  const titleContent = `⏳ ${minuteDuration}`;

  return {
    Name: {
      title: {
        text: {
          content: titleContent,
        },
      },
    },
    'Working Time': {
      date: {
        start: startISO,
        end: endISO,
      },
      type: 'date',
    },
  };
};

const postWorkPeriod = async (
  workPeriod: WorkNotionDatabasePropertySchema,
): Promise<void> => {
  try {
    await notion.pages.create({
      parent: {
        database_id: process.env.NOTION_DATABASE_ID as string,
      },
      properties: workPeriod as any,
    });
  } catch (error) {
    console.error(`Error posting work period: ${error}`);
  }
};

type TimerState = 'idle' | 'work' | 'rest';

type JsonLogLine = {
  event: 'startStop' | 'timerFired';
  fromState: TimerState;
  toState: TimerState;
  unixTimestamp: number;
  type: 'transition';
};

type LogLine = {
  stopping: boolean;
  date: Date;
};

const unixToDate = (unixTimestamp: number): Date => {
  return new Date(unixTimestamp * 1000);
};

const parseLogLine = (line: string): LogLine => {
  const jsonLine: JsonLogLine = JSON.parse(line);
  const date = unixToDate(jsonLine.unixTimestamp);
  const stopping = jsonLine.toState === 'idle' || jsonLine.toState === 'rest';
  return { stopping, date };
};

const getFileLines = async (path: string): Promise<string[]> => {
  try {
    const fileContent = await fs.readFile(path, 'utf-8');
    const lines = fileContent.split('\n');
    return lines;
  } catch (error) {
    console.error(`Error reading file: ${error}`);
    return [];
  }
};

const parseLog = async (path: string): Promise<LogLine[]> => {
  const lines = await getFileLines(path);
  return lines.map(parseLogLine);
};

const getWorkPeriods = async (
  log: LogLine[],
): Promise<WorkNotionDatabasePropertySchema[]> => {
  const workPeriods: WorkNotionDatabasePropertySchema[] = [];

  let workStart: Date | null = null;
  let workEnd: Date | null = null;

  for (const line of log) {
    if (line.stopping && workStart !== null) {
      workEnd = line.date;
      workPeriods.push(await createWorkProperty(workStart, workEnd));
      workStart = null;
      workEnd = null;
    } else if (!line.stopping && workStart === null) {
      workStart = line.date;
    }
  }

  return workPeriods;
};

(async () => {
  // Validate that the environment variables are set
  if (!process.env.NOTION_DATABASE_ID) {
    console.error('Please set the NOTION_DATABASE_ID environment variable.');
    process.exit(1);
  }
  if (!process.env.TOMOTABAR_LOG_PATH) {
    console.error('Please set the TOMOTABAR_LOG_PATH environment variable.');
    process.exit(1);
  }
  if (!process.env.NOTION_API_KEY) {
    console.error('Please set the NOTION_TOKEN environment variable.');
    process.exit(1);
  }
  if (!process.env.PATH_TO_NODE) {
    console.error('Please set the PATH_TO_NODE environment variable.');
    process.exit(1);
  }

  const logLines = await parseLog(process.env.TOMOTABAR_LOG_PATH);

  const workPeriods = await getWorkPeriods(logLines);

  for (const period of workPeriods) {
    console.log(period);
  }
  console.log('Work periods posted to Notion.');
})();
