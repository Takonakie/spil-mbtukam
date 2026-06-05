import pg from 'pg';
import { execSync } from 'child_process';
import { db } from './index.ts';

// Mengambil DATABASE_URL dari environment
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:1234@localhost:5432/interview_analyzer';

async function initDb() {
    console.log('🔄 Memulai inisialisasi database...');

    // 1. Ekstrak informasi koneksi untuk terhubung ke DB default 'postgres' terlebih dahulu
    const url = new URL(connectionString);
    const targetDbName = url.pathname.substring(1); // 'interview_analyzer'

    // Ubah database tujuan sementara ke 'postgres' agar bisa melakukan CREATE DATABASE
    url.pathname = '/postgres';

    const tempPool = new pg.Pool({
        connectionString: url.toString()
    });

    try {
        // Cek apakah database target sudah ada
        const result = await tempPool.query(
            `SELECT 1 FROM pg_database WHERE datname = $1`,
            [targetDbName]
        );

        if (result.rowCount === 0) {
            console.log(`🔨 Database "${targetDbName}" tidak ditemukan. Membuat database baru...`);
            await tempPool.query(`CREATE DATABASE ${targetDbName}`);
            console.log(`✅ Database "${targetDbName}" berhasil dibuat!`);
        } else {
            console.log(`ℹ️ Database "${targetDbName}" sudah ada.`);
        }
    } catch (error) {
        console.error('❌ Gagal memeriksa/membuat database:', error);
        process.exit(1);
    } finally {
        await tempPool.end();
    }

    // 2. Jalankan drizzle-kit push untuk membuat semua tabel
    try {
        console.log('📦 Mendorong skema tabel ke database (db:push)...');
        execSync('npm run db:push', { stdio: 'inherit' });
        console.log('🚀 Database dan tabel berhasil diinisialisasi sepenuhnya!');
    } catch (error) {
        console.error('❌ Gagal menjalankan db:push:', error);
        process.exit(1);
    }
}

initDb();
