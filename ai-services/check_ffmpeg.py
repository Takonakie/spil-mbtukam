import subprocess
import shutil

print("ffmpeg path in shutil.which:", shutil.which("ffmpeg"))
try:
    res = subprocess.run(["ffmpeg", "-version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    print("ffmpeg subprocess status:", res.returncode)
    print("ffmpeg stdout:", res.stdout[:50])
except Exception as e:
    print("ffmpeg subprocess failed:", e)
