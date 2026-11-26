
const fs = require('node:fs/promises');
const { createClient } = require('@supabase/supabase-js');

class SupabaseStorageAdapter {
    constructor(config) {
        const {
            SUPABASE_URL,
            SUPABASE_SECRET_KEY,
            SUPABASE_STORAGE_BUCKET,
        } = config;

        if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !SUPABASE_STORAGE_BUCKET) {
            throw new Error('Supabase storage configuration is incomplete.');
        }

        this.bucketName = SUPABASE_STORAGE_BUCKET;

        this.client = createClient(
            SUPABASE_URL,
            SUPABASE_SECRET_KEY,
            {
                auth: {
                    persistSession: false,
                    autoRefreshToken: false,
                },
            }
        );

        this.bucket = this.client.storage.from(this.bucketName);
    }

    async assertPrivate() {
        const { data, error } = await this.client.storage.getBucket(this.bucketName);
        if (error || !data || data.public !== false) throw new Error('Community media requires a confirmed private storage bucket.');
    }

    async upload(file, key) {
        const body = await fs.readFile(file.path);

        const { data, error } = await this.bucket.upload(key, body, {
            contentType: file.mimetype,
            cacheControl: '3600',
            upsert: false,
        });

        if (error) throw error;

        return {
            provider: 'supabase',
            key: data.path,
            reference: `supabase:${data.path}`,
        };
    }

    parseReference(reference) {
        if (
            typeof reference !== 'string' ||
            !/^supabase:reports\/[a-zA-Z0-9_-]+\/[a-f0-9-]{36}\.(jpg|jpeg|png|webp)$/.test(reference)
        ) {
            throw new Error('Invalid Supabase image reference.');
        }

        return reference.slice('supabase:'.length);
    }

    async getReadUrl(reference) {
        const key = this.parseReference(reference);

        const { data, error } =
            await this.bucket.createSignedUrl(key, 300);

        if (error) throw error;

        return data.signedUrl;
    }

    async remove(reference) {
        const key = this.parseReference(reference);

        const { error } = await this.bucket.remove([key]);

        if (error) throw error;
    }
}

module.exports = SupabaseStorageAdapter;
