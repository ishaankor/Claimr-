import os
import platform
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.keys import Keys
from bs4 import BeautifulSoup
import browser_cookie3
import random
import time

user_agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
]

def get_chrome_user_data_dir():
    """Dynamically resolves Chrome User Data directory for any OS/user."""
    system = platform.system()
    home = os.path.expanduser("~")
    if system == "Darwin":  # macOS
        return os.path.join(home, "Library", "Application Support", "Google", "Chrome")
    elif system == "Windows":
        local_app_data = os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
        return os.path.join(local_app_data, "Google", "Chrome", "User Data")
    elif system == "Linux":
        return os.path.join(home, ".config", "google-chrome")
    return None

def get_cookies():
    try:
        cj = browser_cookie3.chrome(domain_name="egdata.app")
        return [(cookie.name, cookie.value) for cookie in cj]
    except Exception as e:
        print(f"Notice: Could not load cookies from browser: {e}")
        return []

def check_for_permissions():
    print("Checking for permissions...")
    return True

def extract_new_giveaways():
    options = uc.ChromeOptions()
    chrome_dir = get_chrome_user_data_dir()
    if chrome_dir and os.path.exists(chrome_dir):
        options.add_argument(f"--user-data-dir={chrome_dir}")
        if os.path.exists(os.path.join(chrome_dir, "Profile 1")):
            options.add_argument("--profile-directory=Profile 1")
        elif os.path.exists(os.path.join(chrome_dir, "Default")):
            options.add_argument("--profile-directory=Default")

    options.add_argument("--start-maximized")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")

    # Start Chrome
    driver = uc.Chrome(options=options, use_subprocess=True)
    print("Starting Chrome...") 
    driver.get("https://egdata.app/freebies?query=&sortBy=giveawayDate&sortDir=desc&page=1")
    driver.refresh()
    redeem = WebDriverWait(driver, 5).until(EC.presence_of_element_located((By.CSS_SELECTOR, 'button.shadow > span:nth-child(2)')))

    time.sleep(3)
    redeem.click()

    time.sleep(5)

    soup = BeautifulSoup(driver.page_source, "html.parser")
    available_giveaway_games = set()

    giveaways = soup.find('section', id='giveaways-carousel')
    if not giveaways:
        print("Giveaways section not found.")
        return set()

    giveaway_container = giveaways.find('div', class_='flex flex-row items-stretch justify-evenly gap-6 w-full')
    giveaway_games = giveaway_container.find_all('a', class_='flex flex-col rounded-lg shadow-md overflow-hidden w-[300px]')

    for i, game in enumerate(giveaway_games, start=1):
        game_name = game.find('h3', class_='text-lg font-medium mb-2')
        game_price = game.find('span', class_='text-xl font-bold')
        if game_name and game_price and game_price.text.lower() == "free":
            print(f"{i}. {game_name.text} - {game_price.text}")
            available_giveaway_games.add(game_name.text)

    return available_giveaway_games

def human_type(element, text):
    for char in text:
        element.send_keys(char)
        time.sleep(random.uniform(0.05, 0.2))

def login_and_claim_games(free_games: set):
    options = uc.ChromeOptions()
    options.add_argument(f'user-agent={random.choice(user_agents)}')
    driver = uc.Chrome(options=options)

    driver.get("https://store.epicgames.com")
    for name, value in get_cookies():
        try:
            driver.add_cookie({"name": name, "value": value})
        except Exception as e:
            print(f"Cookie error: {e}")

    driver.refresh()

    for game in free_games:
        try:
            print(f"Searching for game: {game}")
            search_input = driver.find_element(By.ID, 'global-search-input')
            search_input.clear()
            human_type(search_input, game)
            # search_input.send_keys(Keys.RETURN)
            time.sleep(3)

            game_container = WebDriverWait(driver, 15).until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, 'div[data-placement="bottom-start"]'))
            )
            queried_games = game_container.find_elements(By.TAG_NAME, 'li')
            for game_div in queried_games:
                if game_div.text.strip().lower() == game.strip().lower():
                    game_div.click()
                    break

            time.sleep(5)

            buy_button = WebDriverWait(driver, 60).until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, '.eds_14hl3lj9.eds_14hl3ljb.eds_14hl3ljh.eds_1ypbntdc.eds_14hl3lja.eds_14hl3lj2.css-17gehj5'))
            )
            buy_button.click()
            print(f"Clicked on Buy button for {game}!")

            try:
                WebDriverWait(driver, 10).until(
                    EC.presence_of_element_located((By.XPATH, '//*[contains(text(), "Device not supported")]'))
                )
                modal = WebDriverWait(driver, 10).until(
                    EC.presence_of_element_located((By.CSS_SELECTOR, 'div[tabindex="-1"]'))
                )
                buttons = modal.find_elements(By.TAG_NAME, 'button')
                for button in buttons:
                    if button.text == "Continue":
                        button.click()
                        print("Clicked on Continue button!")
                        break
            except:
                print("No 'Continue' modal found, proceeding...")

            WebDriverWait(driver, 15).until(
                EC.frame_to_be_available_and_switch_to_it((By.XPATH, '//iframe[contains(@src, "/purchase")]'))
            )
            confirm_button = WebDriverWait(driver, 15).until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, 'button.payment-btn--primary'))
            )
            confirm_button.click()
            print(f"Confirmed purchase for {game}!")

            time.sleep(random.uniform(5.0, 8.0))
            driver.switch_to.default_content()
            driver.get("https://store.epicgames.com")
            time.sleep(3)

        except Exception as e:
            print(f"Error buying {game}: {e}")
            driver.get("https://store.epicgames.com")
            continue

    driver.quit()

def main():
    check_for_permissions()
    free_games = extract_new_giveaways()
    login_and_claim_games(free_games)

if __name__ == '__main__':
    main()
