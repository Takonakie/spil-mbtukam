import { db } from './db/index.ts';
import { interviewsTable, transcriptSegmentsTable } from './db/schema.ts';

async function check() {
  console.log("Checking DB...");
  const interviews = await db.select().from(interviewsTable);
  console.log(`Found ${interviews.length} interviews:`);
  for (const iv of interviews) {
    console.log(`- [${iv.id}] Name: ${iv.candidateName}, Status: ${iv.status}`);
  }

  // Let's do a direct select
  const allSegments = await db.select().from(transcriptSegmentsTable);
  console.log(`Found ${allSegments.length} total segments.`);
  const speakerCounts: Record<string, number> = {};
  for (const seg of allSegments) {
    speakerCounts[seg.speaker] = (speakerCounts[seg.speaker] || 0) + 1;
  }
  console.log("Speaker counts:", speakerCounts);
  
  if (allSegments.length > 0) {
    console.log("Sample segments (first 20):");
    allSegments.slice(0, 20).forEach(seg => {
      console.log(`[${seg.speaker}] (${seg.startTime.toFixed(1)}s-${seg.endTime.toFixed(1)}s): ${seg.text}`);
    });
  }
  process.exit(0);
}

check().catch(err => {
  console.error(err);
  process.exit(1);
});
