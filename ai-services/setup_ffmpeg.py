import os
import shutil
import imageio_ffmpeg

try:
    exe_path = imageio_ffmpeg.get_ffmpeg_exe()
    target_path = os.path.join(os.path.dirname(__file__), 'venv', 'Scripts', 'ffmpeg.exe')
    
    print(f"Found ffmpeg at {exe_path}")
    print(f"Copying to {target_path}")
    
    shutil.copy2(exe_path, target_path)
    print("Done!")
except Exception as e:
    print(f"Error: {e}")
