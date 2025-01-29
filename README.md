# Nextcloud MediaDC Duplicate Deletion Tool

A script to delete duplicate files from Nextcloud based on data exported by the [MediaDC](https://github.com/cloud-py-api/mediadc) app. This tool focuses on cleaning up duplicates while respecting include/exclude patterns.


This WILL delete files so make sure to run a `--dry-run` session first.

Enabling the trash bin (and increasing its size) in the NC instance is also really helpful to inspect which files were removed.

## How it works

This script processes groups of duplicate files identified by MediaDC and deletes duplicate files always keeping at least one. It connects to your Nextcloud instance via WebDAV and operates based on exported data from the MediaDC app.

Key features:
- Delete duplicate files
- Respect file inclusion/exclusion patterns
- Provide detailed progress output and summary

## Usage

You need to find the duplicates on your Nextcloud instance first. For that head over to MediaDC docs.

Export the duplicate finder task result in **json**. Get the full path of that file to use in the script.

*Optional*: If you have 2FA, create a device password by going to *Personal settings > Security > Device & sessions* in your Nextcloud instance and create a new device password for the script (you can use any name).

The script is executed using:

```bash
./massdelete.ts [options] [--] <export-file-from-mediadc.json>
```

### Required Arguments

- **Nextcloud URL** (`-h` / `--host`)
Nextcloud WebDAV host (e.g., `nextcloud.mydomain.com`)

- **Username** (`-u`)
Your Nextcloud username

- **Password** (`-p`)
Password for the user (I would recommend writing to a file and `$(cat ./thatfile)` for security reasons, but you can use environment variables too if needed.)

- **Export JSON File**
Path to MediaDC export file

### Optional Arguments

- **Exclude Patterns** (`-x` / `--exclude`)
Paths/files to exclude from deletion

- **Include Patterns** (`-i` / `--include`)
Only files matching these patterns will be considered for deletion (useful to limit scope)

See other options with `--help`.

## Examples

Here are examples of how to use the script:

### Basic Usage with Exclude
```bash
./massdelete.ts \
    -h nextcloud.example.com \
    -u myself \
    -p $(cat path/to/passwd_file) \
    --exclude "Photos/from_that_day" "Wedding Folder" ".dng" \
    --include $(cat ./includes_one_each_line.txt) \
    -- /path/to/1_task_results_export.json
```

### Using Include Patterns
```bash
./massdelete.ts \
    -h nextcloud.example.com \
    -u myself \
    -p $(cat path/to/passwd_file) \
    # delete whatsapp, telegram, edited dupes
    --include "WA0" "-edit" "Exports/Telegram" \
    -- /path/to/1_task_results_export.json
```

## Notes

- **Include/Exclude Only for Deletion**: The include/exclude patterns determine which files are considered for **deletion**, not for retention. This means excluded files are skipped.
- **Cache System**: You can disable the cache of file information between runs using `--no-cache-info` (enabled by default). This is useful when running first with `--dry-run` to then after **carefully** inspecting logs and planned deletion, run without `--dry-run` and not having to refetch file stats.

## Contributing

Contributions are welcome! Please fork this repository and submit a pull request if you:
- Find bugs
- Improve performance
- Add new features
- Enhance documentation

Bear in mind that I created this for personal use and may not be able to support your specific needs.

## License

[Unlicense Yourself](LICENSE)
