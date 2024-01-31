import * as dotenv from 'dotenv';
import { Client } from '@notionhq/client';
import { promises, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

dotenv.config();

// Initializing a client
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

type WorkNotionDatabasePropertySchema = {
  Name: {
    title: [
      {
        text: {
          content: string;
        };
      },
    ];
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
  wp: WorkPeriod,
): Promise<WorkNotionDatabasePropertySchema> => {
  const startISO = wp.start.toISOString();
  const endISO = wp.end.toISOString();
  const minuteDuration = (wp.end.getTime() - wp.start.getTime()) / 1000 / 60;

  const titleContent = `⏳ ${minuteDuration}`;

  return {
    Name: {
      title: [
        {
          text: {
            content: titleContent,
          },
        },
      ],
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

type WorkPeriod = {
  start: Date;
  end: Date;
};

const postWorkPeriod = async (workPeriod: WorkPeriod): Promise<void> => {
  const properties = await createWorkProperty(workPeriod);
  console.log(properties);

  await notion.pages.create({
    parent: {
      database_id: process.env.NOTION_DATABASE_ID as string,
    },
    properties,
  });
};

const getLogLinesFromWorkPeriod = (workPeriod: WorkPeriod): string => {
  const startJson: JsonLogLine = {
    event: 'startStop',
    fromState: 'idle',
    toState: 'work',
    timestamp: workPeriod.start.getTime() / 1000,
    type: 'transition',
  };
  const endJson: JsonLogLine = {
    event: 'startStop',
    fromState: 'work',
    toState: 'idle',
    timestamp: workPeriod.end.getTime() / 1000,
    type: 'transition',
  };
  return `${JSON.stringify(startJson)}\n${JSON.stringify(endJson)}`;
};

type TimerState = 'idle' | 'work' | 'rest';

type JsonLogLine = {
  event: 'startStop' | 'timerFired';
  fromState: TimerState;
  toState: TimerState;
  timestamp: number;
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
  const date = unixToDate(jsonLine.timestamp);
  const stopping = jsonLine.toState === 'idle' || jsonLine.toState === 'rest';
  return { stopping, date };
};

const getFileLines = async (path: string): Promise<string[]> => {
  try {
    const fileContent = await promises.readFile(path, 'utf-8');
    const lines = fileContent.split('\n');
    return lines.filter((line) => line.length > 0);
  } catch (error) {
    console.error(`Error reading file: ${error}`);
    return [];
  }
};

const parseLog = async (path: string): Promise<LogLine[]> => {
  const lines = await getFileLines(path);
  return lines.map(parseLogLine);
};

const normalizeWorkPeriod = (start: Date, end: Date): WorkPeriod | null => {
  const MINUTE = 60 * 1000;
  const MAX_WORK_PERIOD = 25 * MINUTE;
  const MIN_WORK_PERIOD = 5 * MINUTE;
  const startTimestamp = start.getTime();
  const endTimestamp = end.getTime();
  const duration = endTimestamp - startTimestamp;
  const periods = Math.round(duration / MINUTE);
  const minuteDuration = periods * MINUTE;
  const truncatedDuration = Math.min(minuteDuration, MAX_WORK_PERIOD);
  if (minuteDuration < MIN_WORK_PERIOD) {
    return null;
  }
  return {
    start: new Date(startTimestamp),
    end: new Date(startTimestamp + truncatedDuration),
  };
};

const getWorkPeriods = async (log: LogLine[]): Promise<WorkPeriod[]> => {
  const workPeriods: WorkPeriod[] = [];

  let workStart: Date | null = null;
  let workEnd: Date | null = null;

  for (const line of log) {
    if (line.stopping && workStart !== null) {
      workEnd = line.date;
      const normalizedPeriod = normalizeWorkPeriod(workStart, workEnd);
      if (normalizedPeriod) {
        workPeriods.push(normalizedPeriod);
      }
      workStart = null;
      workEnd = null;
    } else if (!line.stopping && workStart === null) {
      workStart = line.date;
    }
  }

  return workPeriods;
};

const checkForFailures = async (failureLogPath: string) => {
  // Check if log file exists with out try catch block
  const exists = existsSync(failureLogPath);
  if (!exists) {
    return;
  }

  const lines = await getFileLines(failureLogPath);
  if (lines.length === 0) {
    return;
  }

  const logLines = await parseLog(failureLogPath);

  // clear the log file
  await promises.writeFile(failureLogPath, '');

  return logLines;
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
  if (!process.env.FAILURES_LOG_PATH) {
    console.error('Please set the FAILURES_LOG_PATH environment variable.');
    process.exit(1);
  }

  const homeDir = homedir();
  const resolvedPath = resolve(
    process.env.TOMOTABAR_LOG_PATH.replace('~', homeDir),
  );

  const resolvedFailuresPath = resolve(
    process.env.FAILURES_LOG_PATH.replace('~', homeDir),
  );

  const logLines = await parseLog(resolvedPath);
  const failures = await checkForFailures(resolvedFailuresPath);
  if (failures) {
    logLines.push(...failures);
  }

  if (logLines.length === 0) {
    console.error('No log lines found.');
    process.exit(1);
  }

  if (!logLines[logLines.length - 1].stopping) {
    console.error('In progress work period. Nothing to be posted to Notion.');
    process.exit(0);
  }

  const workPeriods = await getWorkPeriods(logLines);

  // Post each work period to Notion. If there are any errors log it to the console and to the failures log file.
  for (const workPeriod of workPeriods) {
    try {
      await postWorkPeriod(workPeriod);
    } catch (error) {
      console.error(`Error posting work period to Notion: ${error}`);
      await promises.appendFile(
        resolvedFailuresPath,
        getLogLinesFromWorkPeriod(workPeriod) + '\n',
      );
    }
  }

  // Clear the log file
  await promises.writeFile(resolvedPath, '');

  console.log('Work periods posted to Notion.');
})();

// (async () => {
//   //post example work period. Of now and 25 minutes ago
//   const now = new Date();
//   const ago25 = new Date(now.getTime() - 25 * 60 * 1000);
//   await postWorkPeriod({ start: ago25, end: now });
// })();
